import { db, getAdminAuth } from './_admin.js';
import { sameOriginRequest } from './_adminSession.js';
import { createVaultBackup } from './_vaultBackups.js';
import { createCommunityScriptBackup } from './_communityScriptBackups.js';

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

async function signedInUser(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try { return await getAdminAuth().verifyIdToken(match[1]); }
    catch { return null; }
}

function backupItem(doc, backupType = 'vault') {
    const data = doc.data();
    return {
        id: doc.id,
        backupType,
        vaultId: String(data.vaultId || ''),
        scriptId: String(data.scriptId || ''),
        title: String(data.title || 'Untitled Vault'),
        createdAt: Number(data.createdAt) || 0,
        reason: String(data.reason || 'before_save')
    };
}

export default async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (req.method === 'POST' && !sameOriginRequest(req)) {
        return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    }

    const user = await signedInUser(req);
    if (!user) return json(res, 401, { ok: false, message: 'Sign in to manage backup requests.' });

    try {
        if (req.method === 'GET') {
            const [backupSnap, scriptBackupSnap, requestSnap] = await Promise.all([
                db.collection('vaultBackups').where('ownerUid', '==', user.uid).get(),
                db.collection('communityScriptBackups').where('ownerUid', '==', user.uid).get(),
                db.collection('restoreRequests').where('ownerUid', '==', user.uid).get()
            ]);
            const backups = backupSnap.docs.map(doc => backupItem(doc, 'vault'))
                .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
            const scriptBackups = scriptBackupSnap.docs.map(doc => backupItem(doc, 'communityScript'))
                .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
            const requests = requestSnap.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    backupType: data.backupType === 'communityScript' ? 'communityScript' : 'vault',
                    backupId: String(data.backupId || ''),
                    vaultId: String(data.vaultId || ''),
                    scriptId: String(data.scriptId || ''),
                    title: String(data.title || 'Untitled Vault'),
                    status: String(data.status || 'pending'),
                    createdAt: Number(data.createdAt) || 0,
                    handledAt: Number(data.handledAt) || 0
                };
            }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
            return json(res, 200, { ok: true, backups, scriptBackups, requests });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const action = String(body.action || '');
        if (action === 'snapshot') {
            const vaultId = String(body.vaultId || '');
            if (!/^[A-Za-z0-9_-]{1,150}$/.test(vaultId)) return json(res, 400, { ok: false, message: 'Choose a valid vault.' });
            const ref = db.collection('vaults').doc(vaultId);
            const snap = await ref.get();
            if (!snap.exists) return json(res, 404, { ok: false, message: 'That vault could not be found for backup.' });
            const vault = snap.data();
            if (String(vault.uid || '') !== user.uid) return json(res, 403, { ok: false, message: 'You can only back up a vault owned by your account.' });
            const backup = await createVaultBackup(vaultId, vault, String(body.reason || 'before_save'), user.uid);
            return json(res, 201, { ok: true, backup: backupItem({ id: backup.id, data: backup }) });
        }

        if (action === 'request_restore') {
            const backupType = body.backupType === 'communityScript' ? 'communityScript' : 'vault';
            const backupId = String(body.backupId || '');
            if (!/^[A-Za-z0-9_-]{10,40}$/.test(backupId)) return json(res, 400, { ok: false, message: 'Choose a valid backup.' });
            const backupRef = db.collection(backupType === 'communityScript' ? 'communityScriptBackups' : 'vaultBackups').doc(backupId);
            const backupSnap = await backupRef.get();
            if (!backupSnap.exists || String(backupSnap.data().ownerUid || '') !== user.uid) {
                return json(res, 404, { ok: false, message: 'That backup is not available to this account.' });
            }
            const duplicate = await db.collection('restoreRequests').where('backupId', '==', backupId).get();
            const pending = duplicate.docs.find(doc => doc.data().ownerUid === user.uid
                && (doc.data().backupType === 'communityScript' ? 'communityScript' : 'vault') === backupType
                && doc.data().status === 'pending');
            if (pending) return json(res, 200, { ok: true, requestId: pending.id, alreadyRequested: true });
            const ownerRequests = await db.collection('restoreRequests').where('ownerUid', '==', user.uid).get();
            const pendingCount = ownerRequests.docs.filter(doc => doc.data().status === 'pending').length;
            if (pendingCount >= 10) return json(res, 429, { ok: false, message: 'You already have 10 restore requests waiting. Ask an administrator to review them first.' });

            const requestRef = db.collection('restoreRequests').doc();
            const backupData = backupSnap.data();
            await requestRef.create({
                backupId,
                backupType,
                vaultId: backupType === 'vault' ? String(backupData.vaultId || '') : '',
                scriptId: backupType === 'communityScript' ? String(backupData.scriptId || '') : '',
                title: String(backupData.title || (backupType === 'communityScript' ? 'Untitled script' : 'Untitled Vault')).slice(0, 80),
                ownerUid: user.uid,
                ownerEmail: typeof user.email === 'string' ? user.email.slice(0, 254) : '',
                status: 'pending',
                createdAt: Date.now()
            });
            return json(res, 201, { ok: true, requestId: requestRef.id });
        }

        return json(res, 400, { ok: false, message: 'Choose a supported backup action.' });
    } catch (error) {
        console.error('Vault backup request failed:', error);
        return json(res, 500, { ok: false, message: 'Could not complete the backup request.' });
    }
}
