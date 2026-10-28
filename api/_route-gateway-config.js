import { db, getAdminAuth } from './_admin.js';
import {
    PROVIDERS,
    encryptGatewaySecret,
    gatewayConfig,
    gatewayUrlAllowed,
    lootlabsPostbackUrl,
    newPostbackSecret,
    requestOrigin
} from './_gateway.js';
import { isSafeExternalUrl } from './_safeExternalUrl.js';

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

async function getOwner(req, vaultId) {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return { error: { status: 401, message: 'Sign in before saving link-step settings.' } };
    let decoded;
    try {
        decoded = await getAdminAuth().verifyIdToken(match[1]);
    } catch {
        return { error: { status: 401, message: 'Your sign-in expired. Reload and try again.' } };
    }

    const vaultSnap = await db.collection('vaults').doc(vaultId).get();
    if (!vaultSnap.exists) return { error: { status: 404, message: 'Vault not found.' } };
    const vault = vaultSnap.data();
    if (vault.uid !== decoded.uid && vault.uid !== 'guest') {
        return { error: { status: 403, message: 'Only this vault’s owner can change link-step settings.' } };
    }
    return { vault, vaultRef: vaultSnap.ref };
}

export default async function handler(req, res) {
    const vaultId = String(req.query.id || '');
    if (!vaultId) return json(res, 400, { ok: false, message: 'Missing vault id.' });
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    try {
        const owner = await getOwner(req, vaultId);
        if (owner.error) return json(res, owner.error.status, { ok: false, message: owner.error.message });

        const credentialsRef = db.collection('gatewayCredentials').doc(vaultId);
        const gate = gatewayConfig(owner.vault.publicKeyConfig);
        const saved = await credentialsRef.get();
        const stored = saved.exists ? saved.data() : null;
        const hasSecret = stored?.provider === gate.provider && !!stored?.token;

        if (req.method === 'GET') {
            return json(res, 200, {
                ok: true,
                provider: gate.provider,
                url: gate.url,
                hasSecret,
                secretRequired: !!PROVIDERS[gate.provider]?.secretRequired,
                postbackUrl: gate.provider === 'lootlabs' && stored?.provider === 'lootlabs'
                    ? lootlabsPostbackUrl(requestOrigin(req), vaultId, stored.postbackSecret)
                    : ''
            });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const provider = String(body.provider || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
            return json(res, 400, { ok: false, message: 'Choose a supported link-step provider.' });
        }
        const url = String(body.url || '').trim();
        const secret = String(body.secret || '').trim();

        if (provider === 'none') {
            await owner.vaultRef.update({
                'publicKeyConfig.gateway': { provider: 'none', url: '' },
                'publicKeyConfig.customLinkUrl': ''
            });
            if (saved.exists) await credentialsRef.delete();
            return json(res, 200, { ok: true, provider, hasSecret: false });
        }

        if (!url) return json(res, 400, { ok: false, message: 'Add the link visitors should open.' });

        if (provider === 'custom') {
            if (!isSafeExternalUrl(url)) {
                return json(res, 400, { ok: false, message: 'Use a safe HTTPS link. Local, IP, unsafe, adult-content, and blocked domains are not allowed.' });
            }
        } else if (!gatewayUrlAllowed(provider, url)) {
            return json(res, 400, {
                ok: false,
                message: `Use an https:// link from ${PROVIDERS[provider].label}. Expected a host like ${PROVIDERS[provider].hosts.join(' or ')}.`
            });
        }

        const secretMeta = PROVIDERS[provider] || {};
        if (secretMeta.secretRequired && !secret && !hasSecret) {
            return json(res, 400, {
                ok: false,
                message: `Paste the ${secretMeta.secretLabel || 'provider secret'} from your ${PROVIDERS[provider].label} settings.`
            });
        }
        if (secretMeta.secretPattern && secret && !secretMeta.secretPattern.test(secret)) {
            return json(res, 400, {
                ok: false,
                message: `The ${secretMeta.secretLabel || 'provider secret'} must be ${secretMeta.secretHint || 'formatted correctly'}.`
            });
        }

        let postbackUrl = '';
        if (provider === 'lootlabs') {
            const postbackSecret = stored?.provider === 'lootlabs' && stored.postbackSecret
                ? stored.postbackSecret
                : newPostbackSecret();
            if (stored?.provider !== 'lootlabs' || stored.postbackSecret !== postbackSecret) {
                await credentialsRef.set({ provider, postbackSecret, updatedAt: Date.now() });
            }
            postbackUrl = lootlabsPostbackUrl(requestOrigin(req), vaultId, postbackSecret);
        } else if (secret) {
            const encrypted = encryptGatewaySecret(secret);
            await credentialsRef.set({ ...encrypted, provider, updatedAt: Date.now() });
        } else if (stored && stored.provider !== provider) {
            // Provider changes keep the stored secret only while it still belongs to the same provider.
            await credentialsRef.delete();
        }

        await owner.vaultRef.update({
            'publicKeyConfig.gateway': { provider, url },
            'publicKeyConfig.customLinkUrl': provider === 'custom' ? url : ''
        });

        return json(res, 200, {
            ok: true,
            provider,
            hasSecret: provider === 'lootlabs' ? false : (secret ? true : hasSecret),
            postbackUrl
        });
    } catch (err) {
        const missingKey = err && err.message && /GATEWAY_ENCRYPTION_KEY|LINKVERTISE_ENCRYPTION_KEY/.test(err.message);
        return json(res, 500, {
            ok: false,
            message: missingKey
                ? 'The site owner must add GATEWAY_ENCRYPTION_KEY (base64 32 bytes) to the Vercel environment before link-step secrets can be saved.'
                : 'Could not save link-step settings.'
        });
    }
}
