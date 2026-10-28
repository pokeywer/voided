import { randomBytes } from 'node:crypto';
import { db } from './_admin.js';
import { recordActiveUser } from './_executionStats.js';
import { buildRemovedVaultGui } from './_removedVaultGui.js';
import { getCodeForExecution } from './_deliveryCode.js';
import { deriveBootstrapSeed, issueLoaderToken, requestBinding, verifyLoaderToken } from './_loaderToken.js';
import { buildKeyLoader, buildTrackedScript } from './_loaderSource.js';
import { buildGuiLoader } from './_guiSource.js';

function isExecutorRequest(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    if (req.query.format === 'raw' || req.query.format === 'token-check' || req.query.trackOnly === '1') return true;
    const accept = (req.headers.accept || '').toLowerCase();
    if (accept && !accept.includes('text/html') && (accept.includes('*/*') || accept.includes('text/plain'))) return true;
    return ua.includes('roblox') ||
           ua.includes('synapse') ||
           ua.includes('executor') ||
           ua.includes('script-ware') ||
           ua.includes('krnl') ||
           ua.includes('fluxus') ||
           ua.includes('electron') ||
           ua.includes('curl') ||
           ua === '';
}

export default async function handler(req, res) {
    const id = String(req.query.id || '');
    const key = String(req.query.key || '');
    const userId = req.query.userId;
    const trackOnly = req.query.trackOnly;
    const loaderToken = String(req.query.token || '');
    // Executor requests to /api/raw default to a bootstrap response. The outer
    // loadstring no longer needs a format flag or a token query parameter.
    const mintTokenForBootstrap = req.query.format !== 'token-check' && !loaderToken;

    if (!id) {
        return res.status(400).send('Error: Missing Vault ID');
    }

    if (trackOnly === '1') {
        if (!userId || !/^\d{1,20}$/.test(String(userId))) {
            return res.status(400).send('Error: Invalid player ID');
        }
        try {
            await recordActiveUser(userId);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(204).end();
        } catch (err) {
            return res.status(500).send('Error recording active player');
        }
    }

    // Real browser visitors get sent to the SECURED landing page instead of raw code.
    if (!isExecutorRequest(req)) {
        const keyParam = key ? `&key=${encodeURIComponent(key)}` : '';
        return res.redirect(302, `/vault.html?id=${encodeURIComponent(id)}${keyParam}`);
    }

    if (!mintTokenForBootstrap && !verifyLoaderToken(loaderToken, id, key, undefined, req)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(410).send('error("[VoidedX] Error: Loader expired. Get a new loader from the website and try again.", 0)');
    }

    try {
        const docSnap = await db.collection("vaults").doc(id).get();

        if (!docSnap.exists) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(200).send(buildRemovedVaultGui());
        }

        const vaultData = docSnap.data();
        // Vaults saved before this option existed default to instant: run the
        // payload straight away with no console progress lines.
        const loaderOptions = { instant: vaultData.instantRunEnabled !== false };
        let activeLoaderToken = loaderToken;

        // Public loadstrings stay stable and token-free. The raw endpoint puts a
        // fresh signed token inside the returned encrypted bootstrap on every fetch.
        if (mintTokenForBootstrap) {
            if (vaultData.requireKey && !vaultData.guiMode) {
                if (!key || !(await hasUsableKey(db.collection('vaults').doc(id), vaultData, key))) {
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    return res.status(403).send('error("[VoidedX] Invalid Key Provided!", 2)');
                }
            }
            activeLoaderToken = issueLoaderToken(id, key, vaultData.loaderVersion, requestBinding(req)).token;
        }

        if (!verifyLoaderToken(activeLoaderToken, id, key, vaultData.loaderVersion, req)) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(410).send('error("[VoidedX] Error: Loader expired or was revoked. Get a new loader from the website and try again.", 0)');
        }

        if (vaultData.launchPaused === true) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(423).send('error("[VoidedX] This vault is temporarily paused by its owner.", 0)');
        }

        // The short-lived loader credential is also packed into the returned
        // bootstrap. A copied response body must revalidate it when run,
        // so copying the decoded bootstrap does not bypass its 10-second expiry.
        // The gate returns the token-derived bootstrap seed. The seed is never
        // derivable from the token alone, so a captured bootstrap body cannot be
        // decrypted offline without a live, IP-bound gate request.
        if (req.query.format === 'token-check') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            const seedHex = deriveBootstrapSeed(activeLoaderToken).toString(16).padStart(8, '0');
            const nonce = randomBytes(8).toString('hex');
            return res.status(200).send(`vx1|${seedHex}|${nonce}`);
        }

        // GUI Mode: no key in the URL at all — send an in-game popup instead that
        // asks the player to type their key, then verifies it via /api/verify.
        if (vaultData.requireKey && vaultData.guiMode) {
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(200).send(buildGuiLoader(id, getOrigin(req), vaultData.guiAppearance, vaultData.title, activeLoaderToken, loaderOptions));
        }

        const executionCode = getCodeForExecution(vaultData);

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        if (!vaultData.requireKey) {
            if (typeof executionCode !== 'string' || !executionCode.trim()) {
                return res.status(200).send(executionCode);
            }
            return res.status(200).send(buildTrackedScript(id, getOrigin(req), activeLoaderToken, key, loaderOptions));
        }

        // Key-in-URL mode: fast-fail on an obviously missing key, otherwise hand off
        // to a loader that identifies the player and asks /api/verify to do the real
        // checking (key match, expiry, termination, bans, IP lock, player limits).
        if (!key) {
            return res.status(403).send(`
error("[VoidedX] Invalid Key Provided!", 2)
            `);
        }

        return res.status(200).send(buildKeyLoader(id, key, getOrigin(req), activeLoaderToken, loaderOptions));
    } catch (err) {
        return res.status(500).send(`Error loading script: ${err.message}`);
    }
}

function getStoredKeys(vaultData) {
    if (Array.isArray(vaultData.keys) && vaultData.keys.length > 0) return vaultData.keys;
    if (vaultData.key) return [{ key: vaultData.key, durationDays: null, keyGeneratedAt: vaultData.keyGeneratedAt || null, terminated: false }];
    return [];
}

function isStoredKeyExpired(keyData, now) {
    if (!keyData || !keyData.durationDays || !keyData.keyGeneratedAt) return false;
    const generatedAt = typeof keyData.keyGeneratedAt === 'number'
        ? keyData.keyGeneratedAt
        : keyData.keyGeneratedAt && typeof keyData.keyGeneratedAt.toMillis === 'function'
            ? keyData.keyGeneratedAt.toMillis()
            : Number.NaN;
    const durationDays = Number(keyData.durationDays);
    if (!Number.isFinite(generatedAt) || !Number.isFinite(durationDays) || durationDays <= 0) return false;
    return now >= generatedAt + durationDays * 86_400_000;
}

async function hasUsableKey(vaultRef, vaultData, key) {
    const storedKeys = getStoredKeys(vaultData);
    let matched = storedKeys.find(item => item && item.key === key);
    if (!matched) {
        const issued = await vaultRef.collection('issuedKeys').where('key', '==', key).limit(1).get();
        if (!issued.empty) matched = issued.docs[0].data();
    }
    return !!matched && !matched.terminated && !isStoredKeyExpired(matched, Date.now());
}


function getOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}
