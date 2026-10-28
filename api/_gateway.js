import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isSafeExternalUrl } from './_safeExternalUrl.js';

// Key-gate providers for the public Get-Key page. A vault picks one provider
// and a link; the provider proves the visitor finished the step and the key is
// only issued after that proof is checked server-side.
export const PROVIDERS = {
    none: {
        label: 'No link step',
        urlHint: ''
    },
    custom: {
        label: 'Custom link',
        urlHint: 'https://your-link.example/...'
    },
    linkvertise: {
        label: 'Linkvertise',
        urlHint: 'https://linkvertise.com/…',
        hosts: ['linkvertise.com', 'linkvertise.net', 'link-to.net'],
        secretLabel: 'Anti-Bypass token',
        secretHint: 'Paste the 64-character Anti-Bypass token from your Linkvertise settings.',
        secretPattern: /^[a-f0-9]{64}$/i,
        secretRequired: true
    },
    workink: {
        label: 'Work.ink',
        urlHint: 'https://work.ink/…',
        hosts: ['work.ink']
    },
    lootlabs: {
        label: 'LootLabs',
        urlHint: 'https://lootlabs.gg/…',
        hosts: ['lootlabs.gg', 'lootlabs.com'],
        postback: true
    }
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

function providerId(value) {
    const id = String(value || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? id : '';
}

function encryptionKey() {
    const raw = process.env.GATEWAY_ENCRYPTION_KEY || process.env.LINKVERTISE_ENCRYPTION_KEY || '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw new Error('GATEWAY_ENCRYPTION_KEY must be a base64-encoded 32-byte key (LINKVERTISE_ENCRYPTION_KEY also works).');
    }
    return key;
}

export function encryptGatewaySecret(secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    return {
        token: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
    };
}

export function decryptGatewaySecret(record) {
    if (!record || !record.token || !record.iv || !record.tag) return '';
    try {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(record.token, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        return '';
    }
}

export function gatewayConfig(cfg) {
    const configured = cfg && typeof cfg.gateway === 'object' && cfg.gateway ? cfg.gateway : null;
    const legacyUrl = String((cfg && cfg.customLinkUrl) || '').trim();
    let provider = providerId(configured && configured.provider);
    if (!provider) provider = legacyUrl ? 'custom' : 'none';
    const url = String((configured && configured.url) || (provider === 'custom' ? legacyUrl : '') || '').trim();
    return {
        provider,
        url,
        hasGate: provider !== 'none' && !!url
    };
}

export function gatewayUrlAllowed(provider, url) {
    if (!isSafeExternalUrl(url)) return false;
    const meta = PROVIDERS[provider];
    if (!meta || !meta.hosts) return true;
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return false;
    }
    return meta.hosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function gatewayUrlBlocked(provider, url) {
    if (!url) return false;
    if (!isSafeExternalUrl(url)) return true;
    const meta = PROVIDERS[provider];
    if (!meta || !meta.hosts) return false;
    return !gatewayUrlAllowed(provider, url);
}

export function gatewayPublicView(cfg) {
    const gate = gatewayConfig(cfg);
    const meta = PROVIDERS[gate.provider] || PROVIDERS.none;
    const blocked = gatewayUrlBlocked(gate.provider, gate.url);
    return {
        provider: gate.provider,
        label: meta.label,
        url: blocked ? '' : gate.url,
        blocked,
        configured: gate.hasGate,
        secretRequired: !!meta.secretRequired
    };
}

// The LootLabs postback is a public URL, so it carries an owner-only secret.
// Without it a visitor could report their own completion and skip the locker.
export function newPostbackSecret() {
    return randomBytes(24).toString('hex');
}

export function lootlabsPostbackUrl(origin, vaultId, secret) {
    if (!origin || !vaultId || !secret) return '';
    return `${String(origin).replace(/\/$/, '')}/api/gateway-postback?id=${encodeURIComponent(vaultId)}&key=${encodeURIComponent(secret)}`;
}

export function sameSecret(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (!left.length || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export function withProviderTicket(link, ticket) {
    try {
        const url = new URL(link);
        // LootLabs echoes the link's "puid" attachment back as click_id.
        url.searchParams.set('puid', ticket);
        return url.toString();
    } catch {
        return '';
    }
}

export function clientIp(req) {
    const forwarded = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    return forwarded || (req && req.socket && req.socket.remoteAddress) || '';
}

export function hashClientIp(ip) {
    return createHash('sha256').update(`vx-gateway-ip\0${String(ip || '')}`).digest('hex').slice(0, 32);
}

export function hashCompletion(provider, hash) {
    return createHash('sha256')
        .update(`vx-gateway-completion\0${String(provider || '')}\0${String(hash || '').toLowerCase()}`)
        .digest('hex');
}

export function requestOrigin(req) {
    const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
    const host = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH64_PATTERN = /^[a-f0-9]{64}$/i;
const REQUEST_TIMEOUT_MS = 6000;

export function validWorkInkToken(value) {
    return UUID_PATTERN.test(String(value || '').trim());
}

export function validLinkvertiseHash(value) {
    return HASH64_PATTERN.test(String(value || '').trim());
}

function baseUrl(envName, fallback) {
    return String(process.env[envName] || fallback).replace(/\/+$/, '');
}

async function timedFetch(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function truthyBody(text) {
    const body = String(text || '').trim();
    if (/^"?true"?$/i.test(body)) return true;
    if (!body) return false;
    try {
        const parsed = JSON.parse(body);
        if (parsed === true) return true;
        if (parsed && typeof parsed === 'object') {
            const candidates = [parsed.valid, parsed.isValid, parsed.is_valid, parsed.success, parsed.ok];
            if (parsed.data && typeof parsed.data === 'object') {
                candidates.push(parsed.data.valid, parsed.data.isValid, parsed.data.is_valid);
            }
            return candidates.some(value => value === true || String(value).toLowerCase() === 'true');
        }
    } catch {
        // Provider returned plain text; fall through to the regex check below.
    }
    return /\btrue\b/i.test(body) && !/\bfalse\b/i.test(body);
}

async function verifyWorkInk(hash) {
    if (!validWorkInkToken(hash)) return { ok: false, reason: 'invalid_hash' };
    const url = `${baseUrl('WORKINK_API_BASE', 'https://work.ink')}/_api/v2/token/isValid/${encodeURIComponent(hash)}?deleteToken=1`;
    const response = await timedFetch(url, { headers: { accept: 'application/json' } });
    if (!response) return { ok: false, reason: 'unreachable' };
    const text = await response.text().catch(() => '');
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: 'rejected' };
    return truthyBody(text) ? { ok: true } : { ok: false, reason: 'rejected' };
}

async function verifyLinkvertise(secret, hash) {
    if (!secret) return { ok: false, reason: 'not_configured' };
    if (!validLinkvertiseHash(hash)) return { ok: false, reason: 'invalid_hash' };
    const url = `${baseUrl('LINKVERTISE_API_BASE', 'https://publisher.linkvertise.com')}/api/v1/anti_bypassing?token=${encodeURIComponent(secret)}`;
    const response = await timedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `hash=${encodeURIComponent(hash.trim())}`
    });
    if (!response) return { ok: false, reason: 'unreachable' };
    const text = await response.text().catch(() => '');
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: 'rejected' };
    return /\btrue\b/i.test(text) ? { ok: true } : { ok: false, reason: 'rejected' };
}

export async function verifyGatewayCompletion(provider, secret, params) {
    const hash = String((params && params.hash) || '').trim();
    if (provider === 'workink') return verifyWorkInk(hash);
    if (provider === 'linkvertise') return verifyLinkvertise(secret, hash);
    return { ok: false, reason: 'unsupported_provider' };
}

export function gatewayFailureMessage(reason) {
    switch (reason) {
        case 'invalid_hash':
            return 'That return code is not valid. Complete the link step again.';
        case 'not_configured':
            return 'The vault owner has not finished setting up this link step. Contact the owner.';
        case 'unreachable':
            return 'The link provider could not be reached to confirm the step. Try again in a moment.';
        case 'unsupported_provider':
            return 'This vault uses a link step that cannot be verified here.';
        default:
            return 'The link step was not completed or was already used. Complete it again for a new key.';
    }
}
