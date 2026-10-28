import { db } from './_admin.js';
import { gatewayConfig, hashClientIp, hashCompletion, sameSecret } from './_gateway.js';

// LootLabs postback receiver. Configure this URL in the LootLabs dashboard
// (Advanced -> Postback) as:
//   https://your-site/api/gateway-postback?id=VAULT_ID
// LootLabs then calls it with click_id, ip and unique_id after a completion.
const CLAIM_QUERY_LIMIT = 10;

function ok(res) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send('OK');
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return res.status(405).send('Method not allowed');
    }

    const vaultId = String(req.query?.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(vaultId)) return res.status(400).send('Bad vault id');
    const clickId = String(req.query?.click_id || '').toLowerCase();
    const uniqueId = String(req.query?.unique_id || '').slice(0, 128);
    const postbackIp = String(req.query?.ip || '');
    const postbackKey = String(req.query?.key || '');
    if (!uniqueId) return res.status(400).send('Missing unique_id');

    try {
        const vaultRef = db.collection('vaults').doc(vaultId);
        const vaultSnap = await vaultRef.get();
        if (!vaultSnap.exists) return res.status(404).send('Unknown vault');
        const gate = gatewayConfig(vaultSnap.data().publicKeyConfig);
        if (gate.provider !== 'lootlabs') return res.status(403).send('Postback not enabled');

        // Only the URL handed to the owner carries this secret, so a visitor
        // cannot report their own click and skip the locker.
        const credentialsSnap = await db.collection('gatewayCredentials').doc(vaultId).get();
        const stored = credentialsSnap.exists ? credentialsSnap.data() : null;
        if (stored?.provider !== 'lootlabs' || !sameSecret(postbackKey, stored.postbackSecret)) {
            return res.status(403).send('Invalid postback key');
        }

        let claimRef = null;
        let claim = null;
        if (/^[a-f0-9]{64}$/.test(clickId)) {
            const claimSnap = await vaultRef.collection('keyClaims').doc(clickId).get();
            if (claimSnap.exists) {
                claimRef = claimSnap.ref;
                claim = claimSnap.data();
            }
        }
        if (!claim && postbackIp) {
            const ipHash = hashClientIp(postbackIp);
            // Single-field lookup keeps this working without a composite index.
            const found = await vaultRef.collection('keyClaims')
                .where('ipHash', '==', ipHash)
                .limit(CLAIM_QUERY_LIMIT)
                .get();
            const now = Date.now();
            const candidate = found.docs
                .map(doc => ({ ref: doc.ref, data: doc.data() }))
                .filter(item => item.data.status === 'started' &&
                    item.data.provider === 'lootlabs' &&
                    Number(item.data.expiresAt) > now)
                .sort((a, b) => Number(b.data.startedAt || 0) - Number(a.data.startedAt || 0))[0];
            if (candidate) {
                claimRef = candidate.ref;
                claim = candidate.data;
            }
        }

        if (!claim || claim.provider !== 'lootlabs' || claim.status !== 'started' || Date.now() >= Number(claim.expiresAt)) {
            return ok(res);
        }
        if (clickId && claimRef.id !== clickId) return ok(res);

        const fingerprint = hashCompletion('lootlabs', uniqueId).slice(0, 40);
        try {
            await db.collection('gatewayCompletions').doc(`${vaultId}_${fingerprint}`).create({
                vaultId,
                provider: 'lootlabs',
                uniqueIdHash: fingerprint,
                claim: claimRef.id,
                postbackIpHash: postbackIp ? hashClientIp(postbackIp) : '',
                usedAt: Date.now(),
                expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
            });
        } catch {
            // Duplicate postback for the same completion: acknowledge and ignore.
            return ok(res);
        }

        await claimRef.update({
            status: 'returned',
            returnedAt: Date.now(),
            postbackIpHash: postbackIp ? hashClientIp(postbackIp) : ''
        });
        return ok(res);
    } catch (error) {
        console.error('LootLabs postback failed:', error);
        return res.status(500).send('Postback failed');
    }
}
