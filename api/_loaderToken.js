import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LOADER_TOKEN_TTL_MS = 10_000;

function secret() {
    const value = process.env.LOADER_TOKEN_SECRET
        || process.env.ADMIN_SESSION_SECRET
        || process.env.FIREBASE_SERVICE_ACCOUNT
        || '';
    if (Buffer.byteLength(value) < 32) throw new Error('Loader token signing secret is not configured.');
    return value;
}

function sign(payload) {
    return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function keyDigest(key) {
    return key ? createHash('sha256').update(String(key)).digest('hex') : '';
}

function normalizeVaultVersion(version) {
    const parsed = Number(version);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function bindingEnabled() {
    return process.env.LOADER_TOKEN_IP_BIND !== '0';
}

// Binds a loader token to the network that requested it. Roblox executor HTTP
// requests originate from the player's own connection, so the initial bootstrap
// fetch and its token-check gate normally share an egress IP.
export function requestBinding(req) {
    if (!bindingEnabled() || !req) return '';
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const address = forwarded || (req.socket && req.socket.remoteAddress) || '';
    if (!address) return '';
    return createHmac('sha256', secret())
        .update(`loader-bind\0${address}`)
        .digest('hex')
        .slice(0, 32);
}

export function deriveBootstrapSeed(token) {
    const digest = createHmac('sha256', secret())
        .update(`loader-bootstrap\0${String(token || '')}`)
        .digest();
    return ((digest.readUInt32BE(0) ^ 0x9E3779B9) >>> 0) || 0x9E3779B9;
}

export function traceForSession(value) {
    return createHmac('sha256', secret())
        .update(`loader-trace\0${String(value || '')}`)
        .digest('hex')
        .slice(0, 16);
}

export function issueLoaderToken(vaultId, key = '', vaultVersion = 0, binding = '') {
    const expiresAt = Date.now() + LOADER_TOKEN_TTL_MS;
    const data = {
        version: 1,
        vaultId: String(vaultId),
        keyHash: keyDigest(key),
        vaultVersion: normalizeVaultVersion(vaultVersion),
        expiresAt,
        nonce: randomBytes(16).toString('base64url')
    };
    if (binding) data.binding = String(binding).slice(0, 64);
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function verifyLoaderToken(token, vaultId, key = '', expectedVaultVersion, req = null) {
    if (typeof token !== 'string' || token.length > 2048) return false;
    const [payload, suppliedSignature, extra] = token.split('.');
    if (!payload || !suppliedSignature || extra !== undefined) return false;
    try {
        const expected = Buffer.from(sign(payload));
        const supplied = Buffer.from(suppliedSignature);
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const versionMatches = expectedVaultVersion === undefined
            || normalizeVaultVersion(data.vaultVersion) === normalizeVaultVersion(expectedVaultVersion);
        const bindingMatches = !data.binding
            || !bindingEnabled()
            || !req
            || data.binding === requestBinding(req);
        return data.version === 1
            && data.vaultId === String(vaultId)
            && data.keyHash === keyDigest(key)
            && versionMatches
            && bindingMatches
            && Number.isFinite(data.expiresAt)
            && Date.now() < data.expiresAt
            && typeof data.nonce === 'string';
    } catch {
        return false;
    }
}

