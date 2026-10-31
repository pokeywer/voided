import { createHash, randomBytes } from 'node:crypto';
import { db } from './_admin.js';
import { recordExecution } from './_executionStats.js';
import { getCodeForExecution } from './_deliveryCode.js';
import { buildShield, sha256Hex, watermarkPrefix } from './_loaderShield.js';
import * as loaderTokenModule from './_loaderToken.js';
import { publicKeyDisabled } from './_keyAccess.js';
import { EXECUTOR_ONLY_MESSAGE, inspectFetch } from './_clientGate.js';

const { traceForSession, verifyLoaderToken } = loaderTokenModule;
// Namespace import so a stale sibling file cannot stop the whole catch-all
// function from loading; the gate below then names the file to upload instead
// of silently accepting an unattested request.
const verifyDeliveryAttestation = typeof loaderTokenModule.verifyDeliveryAttestation === 'function'
    ? loaderTokenModule.verifyDeliveryAttestation
    : null;

const VERIFY_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_LIMIT_ATTEMPTS = 30;
const VERIFY_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;

async function cleanupExpiredSessions() {
    const expired = await db.collection('sessions').where('expiresAt', '<=', Date.now()).limit(25).get();
    await Promise.all(expired.docs.map(doc => doc.ref.delete()));
}

async function cleanupExpiredDeliveryCodes() {
    const expired = await db.collection('deliveryCodes').where('expiresAt', '<=', Date.now()).limit(25).get();
    await Promise.all(expired.docs.map(doc => doc.ref.delete()));
}

async function cleanupExpiredVerificationLimits() {
    const expired = await db.collection('verificationLimits').where('expiresAt', '<=', Date.now()).limit(25).get();
    await Promise.all(expired.docs.map(doc => doc.ref.delete()));
}

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

function getVaultKeys(vaultData) {
    if (Array.isArray(vaultData.keys) && vaultData.keys.length > 0) return vaultData.keys;
    if (vaultData.key) {
        return [{
            id: 'k_legacy', key: vaultData.key, durationDays: null,
            keyGeneratedAt: vaultData.keyGeneratedAt || null,
            maxUsers: 1, maxUsersUnlimited: true, boundUsers: [], terminated: false
        }];
    }
    return [];
}

function keyExpiresAt(key) {
    if (!key || !key.durationDays || !key.keyGeneratedAt) return null;
    const generatedAt = typeof key.keyGeneratedAt === 'number'
        ? key.keyGeneratedAt
        : key.keyGeneratedAt && typeof key.keyGeneratedAt.toMillis === 'function'
            ? key.keyGeneratedAt.toMillis()
            : Number.NaN;
    const durationDays = Number(key.durationDays);
    if (!Number.isFinite(generatedAt) || !Number.isFinite(durationDays) || durationDays <= 0) return null;
    return generatedAt + durationDays * 86400000;
}

function getClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Tickets are tied to the connection that asked for them. Hashes are stored so
// the session document never carries a raw address or user agent.
function bindHash(value) {
    return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function requestBinding(req) {
    return {
        bindIp: bindHash(getClientIp(req)),
        bindUa: bindHash(String(req.headers['user-agent'] || '').slice(0, 200))
    };
}

function keyDigest(key) {
    return createHash('sha256').update(String(key)).digest('hex');
}

async function consumeVerificationAttempt(vaultId, req, configuredLimit) {
    const allowedLimits = [5, 10, 20, 30, 50];
    const attemptLimit = allowedLimits.includes(Number(configuredLimit))
        ? Number(configuredLimit)
        : VERIFY_LIMIT_ATTEMPTS;
    const ip = getClientIp(req);
    const refId = createHash('sha256').update(`${vaultId}\0${ip}`).digest('hex');
    const ref = db.collection('verificationLimits').doc(refId);
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const now = Date.now();
        const state = snap.exists ? snap.data() : {};
        const blockedUntil = Number(state.blockedUntil) || 0;
        if (blockedUntil > now) {
            return { allowed: false, retryAfter: Math.ceil((blockedUntil - now) / 1000) };
        }

        const previousStart = Number(state.windowStartedAt) || 0;
        const sameWindow = previousStart > 0 && now - previousStart < VERIFY_LIMIT_WINDOW_MS;
        const windowStartedAt = sameWindow ? previousStart : now;
        const attempts = (sameWindow ? Number(state.attempts) || 0 : 0) + 1;
        const nextBlockedUntil = attempts > attemptLimit ? now + VERIFY_LIMIT_WINDOW_MS : 0;
        tx.set(ref, {
            vaultId,
            windowStartedAt,
            attempts,
            blockedUntil: nextBlockedUntil,
            expiresAt: now + VERIFY_LIMIT_TTL_MS,
            updatedAt: now
        });
        return nextBlockedUntil > now
            ? { allowed: false, retryAfter: VERIFY_LIMIT_WINDOW_MS / 1000 }
            : { allowed: true };
    });
}

function isBanned(vault, userId) {
    if (!userId) return false;
    const ban = (Array.isArray(vault.bannedUsers) ? vault.bannedUsers : [])
        .find(item => String(item.userId) === userId);
    return !!ban && (ban.bannedUntil == null || Number(ban.bannedUntil) > Date.now());
}

function failure(status, message, code = null) {
    return { ok: false, status, message, code };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    // Same rule as the other two loader hops: a key check comes from a running
    // game, not from a script replaying captured URLs.
    if (inspectFetch(req, String(req.query?.id || 'verify'), 'gate').block) {
        return json(res, 415, { ok: false, message: EXECUTOR_ONLY_MESSAGE });
    }

    const id = String(req.query?.id || '');
    const key = String(req.query?.key || '');
    const rawUserId = req.query?.userId == null ? '' : String(req.query.userId);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
        return json(res, 400, { ok: false, message: 'Missing or invalid vault ID.' });
    }
    if (key.length > 256) return json(res, 400, { ok: false, message: 'Invalid key.' });
    // First of two gates: the request has to carry the attestation that only a
    // bootstrap served by /api/raw for this vault knows.
    if (!verifyDeliveryAttestation) {
        return json(res, 501, { ok: false, message: 'The loader attestation module is out of date. Upload api/_loaderToken.js from the current patch.' });
    }
    const attestedToken = verifyDeliveryAttestation(req.query?.boot, id);
    if (!attestedToken) {
        return json(res, 403, { ok: false, message: 'This loader is not valid. Copy it again from the website.' });
    }
    if (rawUserId && !/^\d{1,20}$/.test(rawUserId)) {
        return json(res, 400, { ok: false, message: 'Invalid player ID.' });
    }
    const rawPlaceId = req.query?.placeId == null ? '' : String(req.query.placeId);
    if (rawPlaceId && !/^\d{1,20}$/.test(rawPlaceId)) {
        return json(res, 400, { ok: false, message: 'Invalid place ID.' });
    }
    const placeId = rawPlaceId || null;
    const userId = rawUserId || null;
    const username = typeof req.query?.username === 'string'
        ? req.query.username.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, 32) || 'Unknown'
        : 'Unknown';
    const executor = typeof req.query?.executor === 'string'
        ? req.query.executor.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, 40)
        : '';
    const hwid = typeof req.query?.hwid === 'string'
        ? req.query.hwid.replace(/[\r\n\t\x00-\x1f\x7f]/g, '').trim().slice(0, 96)
        : '';
    // Vercel sets this for every request; it is a two-letter ISO country code.
    const countryHeader = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const country = /^[A-Z]{2}$/.test(countryHeader) ? countryHeader : null;
    // Subdivision code (ISO-3166-2 without the country prefix, e.g. "SP"). It is
    // the only extra location detail recorded: no address, ISP or IP is stored.
    const regionHeader = String(req.headers['x-vercel-ip-country-region'] || '').toUpperCase();
    const region = /^[A-Z0-9]{1,3}$/.test(regionHeader) ? regionHeader : null;
    const vaultRef = db.collection('vaults').doc(id);
    const sessionToken = randomBytes(32).toString('hex');
    const sessionRef = db.collection('sessions').doc(sessionToken);
    const now = Date.now();

    try {
        try { await cleanupExpiredSessions(); } catch {}
        try { await cleanupExpiredVerificationLimits(); } catch {}
        try { await cleanupExpiredDeliveryCodes(); } catch {}
        const initialSnap = await vaultRef.get();
        if (!initialSnap.exists) {
            return json(res, 200, {
                ok: false,
                code: 'vault_removed',
                message: 'This vault has been removed or deleted. Contact the owner for support.'
            });
        }

        const initialVaultData = initialSnap.data();
        if (initialVaultData.launchPaused === true) {
            return json(res, 200, { ok: false, message: 'This vault is temporarily paused by its owner.' });
        }
        // Second gate input: the embedded loader token must still be valid for
        // this vault and this version, signed, in-date and bound to this network.
        if (!verifyLoaderToken(attestedToken, id, key, initialVaultData.loaderVersion, req)) {
            return json(res, 410, { ok: false, message: 'Error: Loader expired. Get a new loader from the website and try again.' });
        }
        const initiallyKeyed = !!initialVaultData.requireKey;
        if (initiallyKeyed) {
            const rateLimit = await consumeVerificationAttempt(id, req, initialVaultData.verifyLimitAttempts);
            if (!rateLimit.allowed) {
                res.setHeader('Retry-After', String(rateLimit.retryAfter));
                return json(res, 200, { ok: false, message: 'Too many key checks from this network. Wait a few minutes and try again.' });
            }
            if (!userId) return json(res, 400, { ok: false, message: 'A player ID is required for key verification.' });
            if (!key) return json(res, 400, { ok: false, message: 'Missing key.' });
        }

        let issuedKeyRef = null;
        if (initiallyKeyed) {
            const existingKey = getVaultKeys(initialSnap.data()).find(item => item.key === key);
            if (!existingKey) {
                const issuedSnap = await vaultRef.collection('issuedKeys').where('key', '==', key).limit(1).get();
                if (!issuedSnap.empty) issuedKeyRef = issuedSnap.docs[0].ref;
            }
        }

        // Build the payload shield before the session is created. Only the
        // per-session key and trace travel in this response; the ciphertext and
        // its checksum travel in a separate, single-use payload request.
        const reportToken = randomBytes(32).toString('hex');
        const trace = traceForSession(sessionToken);
        let shield = null;
        let shieldHash = '';
        let payloadHash = '';
        try {
            const executionCode = getCodeForExecution(initialVaultData);
            if (typeof executionCode === 'string' && executionCode.trim()) {
                const built = buildShield({ code: watermarkPrefix(trace) + executionCode, trace });
                shield = {
                    key: built.seedHex,
                    trace
                };
                shieldHash = built.hash;
                payloadHash = sha256Hex(executionCode);
            }
        } catch {}

        // Every session now needs a shield: the payload route no longer has a
        // plaintext fallback, so a ticket without one could never be delivered.
        if (!shield) {
            return json(res, 200, {
                ok: false,
                code: 'vault_needs_rebuild',
                message: 'This vault has no protected copy yet. The owner needs to save it again with obfuscation enabled.'
            });
        }

        const shieldFields = {
            shieldSeed: parseInt(shield.key, 16) >>> 0,
            shieldTrace: shield.trace,
            shieldHash,
            shieldPayloadHash: payloadHash,
            reportToken,
            tamperFlags: [],
            blocked: false
        };

        const result = await db.runTransaction(async tx => {
            const freshSnap = await tx.get(vaultRef);
            if (!freshSnap.exists) {
                return failure(200, 'This vault has been removed or deleted. Contact the owner for support.', 'vault_removed');
            }
            const vault = freshSnap.data();
            if (vault.launchPaused === true) return failure(200, 'This vault is temporarily paused by its owner.');
            if (!!vault.requireKey !== initiallyKeyed) {
                return failure(200, 'The vault access settings changed. Run the current loader again.');
            }
            if (isBanned(vault, userId)) return failure(200, 'You are banned from this vault.');

            const allowedTicketLifetimes = [20, 30, 45, 60];
            const ticketLifetimeSeconds = allowedTicketLifetimes.includes(Number(vault.deliveryTicketSeconds))
                ? Number(vault.deliveryTicketSeconds)
                : 45;
            const expiresAt = now + ticketLifetimeSeconds * 1000;
            const sessionBase = {
                vaultId: id,
                createdAt: now,
                expiresAt,
                uses: 0,
                maxUses: 1,
                userId,
                placeId,
                requireKey: initiallyKeyed,
                attested: true,
                ...requestBinding(req),
                ...shieldFields
            };

            tx.set(db.collection('loaderDeliveries').doc(shield.trace), {
                trace: shield.trace,
                vaultId: id,
                userId,
                issuedAt: now,
                // Hashes only: delivery bookkeeping never stores the address or
                // the client signature in readable form.
                ...requestBinding(req),
                placeId,
                version: 5
            }, { merge: true });

            if (!initiallyKeyed) {
                tx.create(sessionRef, sessionBase);
                return { ok: true, token: sessionToken, ticketExpiresAt: expiresAt, expiresAt: null, shield, report: reportToken };
            }

            let matched = null;
            let issuedSnap = null;
            let keys = null;
            let keyIndex = -1;
            if (issuedKeyRef) {
                issuedSnap = await tx.get(issuedKeyRef);
                if (issuedSnap.exists && issuedSnap.data().key === key) matched = issuedSnap.data();
            } else {
                keys = getVaultKeys(vault);
                keyIndex = keys.findIndex(item => item.key === key);
                if (keyIndex >= 0) matched = keys[keyIndex];
            }

            if (!matched) return failure(200, 'Invalid or expired key.');
            if (publicKeyDisabled(vault, matched)) return failure(200, 'The public key for this vault has been disabled by the owner.');
            if (matched.terminated) return failure(200, 'This key has been terminated by the owner.');
            const keyExpiry = keyExpiresAt(matched);
            if (keyExpiry != null && now >= keyExpiry) return failure(200, 'This key has expired.');

            const clientAddress = getClientIp(req);
            const vaultUpdates = {};
            if (vault.ipLock) {
                if (!vault.boundIp) vaultUpdates.boundIp = clientAddress;
                else if (vault.boundIp !== clientAddress) return failure(200, 'This key is locked to a different network/IP.');
            }

            const boundUsers = Array.isArray(matched.boundUsers) ? matched.boundUsers : [];
            const existingBinding = userId
                ? boundUsers.find(item => String(item.userId) === userId)
                : null;
            const maxUsersUnlimited = matched.maxUsersUnlimited === true || matched.maxUsers === 'unlimited';
            const maxUsers = Math.max(1, Number(matched.maxUsers) || 1);
            if (userId && !existingBinding && !maxUsersUnlimited && boundUsers.length >= maxUsers) {
                return failure(200, `This key is already in use by the maximum number of players (${maxUsers}). Ask the vault owner to reset or raise the limit.`);
            }

            if (userId && !existingBinding) {
                const updatedUsers = [...boundUsers, { userId, username, boundAt: now }];
                if (issuedKeyRef) tx.update(issuedKeyRef, { boundUsers: updatedUsers });
                else if (Array.isArray(vault.keys) && vault.keys.length > 0) {
                    const updatedKeys = [...keys];
                    updatedKeys[keyIndex] = { ...matched, boundUsers: updatedUsers };
                    vaultUpdates.keys = updatedKeys;
                }
            }

            if (Object.keys(vaultUpdates).length) tx.update(vaultRef, vaultUpdates);
            tx.create(sessionRef, {
                ...sessionBase,
                keyHash: keyDigest(key),
                keyId: matched.id || 'k_legacy',
                issuedKeyId: issuedKeyRef ? issuedKeyRef.id : null,
                clientIp: vault.ipLock ? clientAddress : null
            });
            return {
                ok: true,
                token: sessionToken,
                ticketExpiresAt: expiresAt,
                expiresAt: keyExpiry,
                remainingSeconds: keyExpiry == null ? null : Math.max(0, Math.ceil((keyExpiry - now) / 1000)),
                keyExpiresAt: keyExpiry,
                shield,
                report: reportToken
            };
        });

        if (!result.ok) {
            return json(res, result.status || 403, {
                ok: false,
                code: result.code,
                message: result.message
            });
        }

        try {
            await recordExecution(vaultRef, id, initialSnap.data().title, userId, {
                username,
                executor,
                hwid,
                country,
                region
            });
        } catch {}
        // Second hop: the script is fetched from its own short-lived path URL,
        // keyed by a 32-character code that exists nowhere in any earlier
        // response. The code points at the same one-use ticket, and is deleted
        // the moment it is spent.
        let deliveryCode = '';
        let deliveryHop = '';
        try {
            deliveryCode = randomBytes(16).toString('hex');
            // A loader that asks for the pair gets a second single-use secret in
            // the path. Both halves are destroyed when the delivery is spent, and
            // the payload key is folded from them, so a captured response body and
            // the session seed alone no longer open anything. A loader that does
            // not ask gets no hop and keeps using the ticket form, so nothing that
            // is already running is stranded by this.
            if (String(req.query?.dual || '') === '1') deliveryHop = randomBytes(16).toString('hex');
            await db.collection('deliveryCodes').doc(deliveryCode).set({
                session: result.token,
                vaultId: id,
                hop: deliveryHop || null,
                expiresAt: result.ticketExpiresAt || Date.now() + 60_000
            });
        } catch {
            deliveryCode = '';
            deliveryHop = '';
        }
        return json(res, 200, {
            ok: true,
            token: result.token,
            delivery: deliveryCode || null,
            hop: deliveryHop || null,
            ticketExpiresAt: result.ticketExpiresAt,
            expiresAt: result.expiresAt,
            remainingSeconds: result.remainingSeconds ?? null,
            keyExpiresAt: result.keyExpiresAt ?? null,
            shield: result.shield ?? null,
            report: result.report ?? null
        });
    } catch (error) {
        console.error('Vault verification failed:', error);
        return json(res, 500, { ok: false, message: 'Could not verify access to this vault.' });
    }
}
