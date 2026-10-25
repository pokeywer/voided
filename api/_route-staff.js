import { db, getAdminAuth } from './_admin.js';
import { getSourceForEditor } from './_deliveryCode.js';

const SCOPES = new Set([
    'vaults', 'vaultSource', 'executions', 'announcements', 'ideas', 'restoreRequests', 'communityScripts'
]);

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

function millis(value) {
    return value && typeof value.toMillis === 'function' ? value.toMillis() : Number(value) || 0;
}

async function signedInUser(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try { return await getAdminAuth().verifyIdToken(match[1]); }
    catch { return null; }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    const user = await signedInUser(req);
    if (!user) return json(res, 401, { ok: false, message: 'Sign in to check staff access.' });

    try {
        const grantSnap = await db.collection('staffAccess').doc(user.uid).get();
        if (!grantSnap.exists) {
            return json(res, 403, { ok: false, message: 'No staff access is assigned to this account.', uid: user.uid });
        }
        const grant = grantSnap.data();
        const expiresAt = Number(grant.expiresAt);
        if (grant.active !== true || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return json(res, 403, { ok: false, message: 'Staff access is expired or has been disabled.', uid: user.uid });
        }
        if (grant.email && String(grant.email).toLowerCase() !== String(user.email || '').toLowerCase()) {
            return json(res, 403, { ok: false, message: 'This staff grant is tied to a different signed-in email.', uid: user.uid });
        }

        const scopes = Array.isArray(grant.scopes) ? [...new Set(grant.scopes.filter(scope => SCOPES.has(scope)))] : [];
        if (scopes.includes('vaultSource') && !scopes.includes('vaults')) {
            return json(res, 403, { ok: false, message: 'This staff grant is incomplete. Ask an administrator to include vault list access.' });
        }
        const data = {};
        if (scopes.includes('vaults')) {
            const snapshot = await db.collection('vaults')
                .select('title', 'uid', 'executions', 'updatedAt', 'requireKey', 'obfuscationEnabled', 'launchPaused')
                .limit(500).get();
            data.vaults = snapshot.docs.map(doc => {
                const item = doc.data();
                return {
                    id: doc.id,
                    title: String(item.title || 'Untitled Vault').slice(0, 80),
                    ownerUid: String(item.uid || ''),
                    executions: Math.max(0, Number(item.executions) || 0),
                    updatedAt: millis(item.updatedAt),
                    requireKey: item.requireKey === true,
                    obfuscated: item.obfuscationEnabled === true,
                    paused: item.launchPaused === true
                };
            }).sort((a, b) => b.updatedAt - a.updatedAt);
        }
        if (scopes.includes('executions')) {
            const [vaults, daily] = await Promise.all([
                db.collection('vaults').select('executions').get(),
                db.collection('siteActivityDaily').orderBy('date', 'desc').limit(14).get()
            ]);
            data.executions = {
                lifetime: vaults.docs.reduce((total, doc) => total + Math.max(0, Number(doc.data().executions) || 0), 0),
                daily: daily.docs.map(doc => ({ date: String(doc.data().date || doc.id), executions: Math.max(0, Number(doc.data().executions) || 0) }))
            };
        }
        const requestedVaultId = String(req.query?.vaultId || '');
        if (scopes.includes('vaultSource') && requestedVaultId) {
            if (!/^[A-Za-z0-9_-]{1,150}$/.test(requestedVaultId)) return json(res, 400, { ok: false, message: 'Choose a valid vault.' });
            const sourceSnap = await db.collection('vaults').doc(requestedVaultId).get();
            if (sourceSnap.exists) {
                const sourceData = sourceSnap.data();
                data.vaultSource = {
                    id: sourceSnap.id,
                    title: String(sourceData.title || 'Untitled Vault').slice(0, 80),
                    source: getSourceForEditor(sourceData)
                };
            }
        }
        if (scopes.includes('announcements')) {
            const snap = await db.collection('siteSettings').doc('announcement').get();
            const raw = snap.exists ? snap.data() : {};
            const items = Array.isArray(raw.announcements) ? raw.announcements : raw.title ? [raw] : [];
            data.announcements = items.map(item => ({
                title: String(item.title || '').slice(0, 80),
                message: String(item.message || '').slice(0, 500),
                kind: ['info', 'success', 'warning'].includes(item.kind) ? item.kind : 'info',
                enabled: item.enabled !== false,
                expiresAt: Math.max(0, Number(item.expiresAt) || 0),
                updatedAt: Math.max(0, Number(item.updatedAt) || 0)
            })).filter(item => item.title && item.message);
        }
        if (scopes.includes('ideas')) {
            const snapshot = await db.collection('feature_requests').orderBy('createdAt', 'desc').limit(50).get();
            data.ideas = snapshot.docs.map(doc => {
                const item = doc.data();
                return { id: doc.id, name: String(item.name || 'Anonymous').slice(0, 40), idea: String(item.idea || '').slice(0, 1000), status: item.status === 'reviewed' ? 'reviewed' : 'new', createdAt: millis(item.createdAt) };
            });
        }
        if (scopes.includes('restoreRequests')) {
            const snapshot = await db.collection('restoreRequests').orderBy('createdAt', 'desc').limit(50).get();
            data.restoreRequests = snapshot.docs.map(doc => {
                const item = doc.data();
                return {
                    id: doc.id,
                    backupType: item.backupType === 'communityScript' ? 'communityScript' : 'vault',
                    title: String(item.title || (item.backupType === 'communityScript' ? 'Untitled script' : 'Untitled Vault')),
                    vaultId: String(item.vaultId || ''),
                    scriptId: String(item.scriptId || ''),
                    status: String(item.status || 'pending'),
                    createdAt: Number(item.createdAt) || 0
                };
            });
        }
        if (scopes.includes('communityScripts')) {
            const snapshot = await db.collection('communityScripts').where('status', '==', 'pending').limit(50).get();
            data.communityScripts = snapshot.docs.map(doc => {
                const item = doc.data();
                return { id: doc.id, title: String(item.title || 'Untitled script').slice(0, 80), game: String(item.game || 'Any game').slice(0, 80), category: String(item.category || 'Other').slice(0, 40), createdAt: Number(item.createdAt) || 0 };
            }).sort((a, b) => b.createdAt - a.createdAt);
        }

        return json(res, 200, {
            ok: true,
            staff: {
                uid: user.uid,
                email: String(user.email || ''),
                isGuest: user.firebase?.sign_in_provider === 'anonymous',
                expiresAt,
                scopes
            },
            data
        });
    } catch (error) {
        console.error('Staff panel request failed:', error);
        return json(res, 500, { ok: false, message: 'Could not load staff data.' });
    }
}
