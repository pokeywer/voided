import { db, getAdminAuth } from './_admin.js';
import { hasAdminSession, sameOriginRequest } from './_adminSession.js';
import { createVaultBackup, readVaultBackupData } from './_vaultBackups.js';
import { createCommunityScriptBackup } from './_communityScriptBackups.js';

const STAFF_SCOPES = new Set([
    'vaults', 'vaultSource', 'executions', 'announcements', 'announcementManage',
    'ideas', 'ideaTriage', 'restoreRequests', 'restoreTriage',
    'communityScripts', 'communityModeration'
]);

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

function backupSummary(doc, backupType = 'vault') {
    const item = doc.data();
    return {
        id: doc.id,
        backupType,
        vaultId: String(item.vaultId || ''),
        scriptId: String(item.scriptId || ''),
        ownerUid: String(item.ownerUid || ''),
        title: String(item.title || (backupType === 'communityScript' ? 'Untitled script' : 'Untitled Vault')).slice(0, 80),
        reason: String(item.reason || 'before_save'),
        createdAt: Number(item.createdAt) || 0
    };
}

export default async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (req.method === 'POST' && !sameOriginRequest(req)) return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    if (!hasAdminSession(req)) return json(res, 401, { ok: false, message: 'Your admin session expired. Sign in again.' });

    try {
        if (req.method === 'GET') {
            const [backupsSnap, scriptBackupsSnap, requestsSnap, staffSnap] = await Promise.all([
                db.collection('vaultBackups').orderBy('createdAt', 'desc').limit(100).get(),
                db.collection('communityScriptBackups').orderBy('createdAt', 'desc').limit(100).get(),
                db.collection('restoreRequests').orderBy('createdAt', 'desc').limit(100).get(),
                db.collection('staffAccess').get()
            ]);
            const requests = requestsSnap.docs.map(doc => {
                const item = doc.data();
                return {
                    id: doc.id,
                    backupType: item.backupType === 'communityScript' ? 'communityScript' : 'vault',
                    backupId: String(item.backupId || ''),
                    vaultId: String(item.vaultId || ''),
                    scriptId: String(item.scriptId || ''),
                    ownerUid: String(item.ownerUid || ''),
                    ownerEmail: String(item.ownerEmail || ''),
                    title: String(item.title || 'Untitled Vault'),
                    status: String(item.status || 'pending'),
                    staffNotes: Array.isArray(item.staffNotes) ? item.staffNotes.slice(-8).map(note => ({ email: String(note.email || ''), text: String(note.text || '').slice(0, 500) })) : [],
                    createdAt: Number(item.createdAt) || 0
                };
            });
            const staff = staffSnap.docs.map(doc => {
                const item = doc.data();
                return {
                    uid: doc.id,
                    email: String(item.email || ''),
                    expiresAt: Number(item.expiresAt) || 0,
                    active: item.active === true && Number(item.expiresAt) > Date.now(),
                    scopes: Array.isArray(item.scopes) ? item.scopes.filter(scope => STAFF_SCOPES.has(scope)) : []
                };
            }).sort((a, b) => b.expiresAt - a.expiresAt);
            const backups = [
                ...backupsSnap.docs.map(doc => backupSummary(doc, 'vault')),
                ...scriptBackupsSnap.docs.map(doc => backupSummary(doc, 'communityScript'))
            ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
            return json(res, 200, { ok: true, backups, requests, staff });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const action = String(body.action || '');

        if (action === 'grant_staff') {
            const requestedUid = String(body.uid || '').trim();
            const email = String(body.email || '').trim().toLowerCase();
            let account = null;
            if (email) {
                if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { ok: false, message: 'Enter a valid account email.' });
                try { account = await getAdminAuth().getUserByEmail(email); }
                catch { return json(res, 404, { ok: false, message: 'No VoidedX account was found for that email. Ask the staff member to sign in once, then use their account ID.' }); }
            }
            if (requestedUid && !/^[A-Za-z0-9:_-]{1,128}$/.test(requestedUid)) return json(res, 400, { ok: false, message: 'Enter a valid Firebase account ID.' });
            if (requestedUid && !account) {
                try { account = await getAdminAuth().getUser(requestedUid); }
                catch { return json(res, 404, { ok: false, message: 'No VoidedX account was found for that ID. Ask the staff member to sign in once, then copy the ID from the staff panel.' }); }
            }
            if (account && requestedUid && account.uid !== requestedUid) return json(res, 400, { ok: false, message: 'That email and account ID belong to different accounts.' });
            const uid = account?.uid || requestedUid;
            if (!uid) return json(res, 400, { ok: false, message: 'Enter the staff member’s account ID or email.' });
            const hours = Number(body.durationHours);
            if (!Number.isSafeInteger(hours) || hours < 1 || hours > 8760) return json(res, 400, { ok: false, message: 'Choose an access duration from 1 hour to 1 year.' });
            const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes.filter(scope => STAFF_SCOPES.has(scope)))] : [];
            if (!scopes.length) return json(res, 400, { ok: false, message: 'Choose at least one staff permission.' });
            if (scopes.includes('vaultSource') && !scopes.includes('vaults')) return json(res, 400, { ok: false, message: 'Readable vault source access also needs the vault list permission.' });
            if (scopes.includes('announcementManage') && !scopes.includes('announcements')) return json(res, 400, { ok: false, message: 'Announcement management also needs announcement access.' });
            if (scopes.includes('ideaTriage') && !scopes.includes('ideas')) return json(res, 400, { ok: false, message: 'Idea triage also needs feature idea access.' });
            if (scopes.includes('restoreTriage') && !scopes.includes('restoreRequests')) return json(res, 400, { ok: false, message: 'Restore request triage also needs restore request access.' });
            if (scopes.includes('communityModeration') && !scopes.includes('communityScripts')) return json(res, 400, { ok: false, message: 'Community moderation also needs community script access.' });
            const finalEmail = String(account?.email || email || '').toLowerCase();
            const grant = {
                email: finalEmail,
                scopes,
                active: true,
                createdAt: Date.now(),
                expiresAt: Date.now() + hours * 60 * 60 * 1000,
                createdBy: 'admin'
            };
            await db.collection('staffAccess').doc(uid).set(grant);
            return json(res, 200, { ok: true, uid, grant });
        }

        if (action === 'revoke_staff') {
            const uid = String(body.uid || '');
            if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) return json(res, 400, { ok: false, message: 'Choose a valid staff account.' });
            await db.collection('staffAccess').doc(uid).set({ active: false, revokedAt: Date.now() }, { merge: true });
            return json(res, 200, { ok: true });
        }

        if (action === 'restore_backup') {
            const backupType = body.backupType === 'communityScript' ? 'communityScript' : 'vault';
            const backupId = String(body.backupId || '');
            if (!/^[A-Za-z0-9_-]{10,40}$/.test(backupId)) return json(res, 400, { ok: false, message: 'Choose a valid backup.' });
            const backupRef = db.collection(backupType === 'communityScript' ? 'communityScriptBackups' : 'vaultBackups').doc(backupId);
            const backupSnap = await backupRef.get();
            if (!backupSnap.exists) return json(res, 404, { ok: false, message: 'That backup has expired or was removed.' });
            const backup = backupSnap.data();

            if (backupType === 'communityScript') {
                if (!backup.data || typeof backup.data !== 'object' || !backup.ownerUid || !backup.scriptId) {
                    return json(res, 400, { ok: false, message: 'That script backup is incomplete and cannot be restored.' });
                }
                const scriptRef = db.collection('communityScripts').doc(String(backup.scriptId));
                const currentSnap = await scriptRef.get();
                const current = currentSnap.exists ? currentSnap.data() : null;
                if (current && String(current.ownerUid || '') !== String(backup.ownerUid)) {
                    return json(res, 409, { ok: false, message: 'A different account now owns that script. The backup was not restored.' });
                }
                if (current) await createCommunityScriptBackup(String(backup.scriptId), current, 'before_restore', 'admin');
                const now = Date.now();
                const restored = {
                    ...backup.data,
                    ownerUid: String(backup.ownerUid),
                    updatedAt: now,
                    restoredAt: now,
                    restoredFromBackup: backupId
                };
                if (current) {
                    for (const field of ['likes', 'views', 'downloads', 'reports']) {
                        if (Object.prototype.hasOwnProperty.call(current, field)) restored[field] = current[field];
                    }
                }
                await scriptRef.set(restored);

                const matchingRequests = await db.collection('restoreRequests').where('backupId', '==', backupId).get();
                const pendingRequests = matchingRequests.docs.filter(doc => {
                    const item = doc.data();
                    return ['pending', 'in_review', 'needs_admin'].includes(item.status) && item.backupType === 'communityScript';
                });
                if (pendingRequests.length) {
                    const batch = db.batch();
                    for (const request of pendingRequests) batch.update(request.ref, { status: 'restored', handledAt: now });
                    await batch.commit();
                }
                return json(res, 200, { ok: true, backupType, scriptId: String(backup.scriptId), title: String(backup.title || 'Untitled script'), recreated: !current });
            }

            const backupData = await readVaultBackupData(backupRef, backup);
            if (!backupData || !backup.ownerUid || !backup.vaultId) return json(res, 400, { ok: false, message: 'That backup is incomplete and cannot be restored.' });
            const vaultRef = db.collection('vaults').doc(String(backup.vaultId));
            const currentSnap = await vaultRef.get();
            const current = currentSnap.exists ? currentSnap.data() : null;
            if (current && String(current.uid || '') !== String(backup.ownerUid)) return json(res, 409, { ok: false, message: 'A different account now owns that vault. The backup was not restored.' });
            if (current) await createVaultBackup(String(backup.vaultId), current, 'before_restore', 'admin');

            const now = Date.now();
            const nextVersion = Math.max(Number(current?.loaderVersion) || 0, Number(backupData.loaderVersion) || 0) + 1;
            const restored = {
                ...backupData,
                uid: String(backup.ownerUid),
                loaderVersion: nextVersion,
                updatedAt: now,
                autoDeleteAt: null,
                restoredAt: now,
                restoredFromBackup: backupId
            };
            if (current) {
                for (const field of ['executions', 'requireKey', 'guiMode', 'guiAppearance', 'publicKeyConfig', 'keys', 'key', 'keyGeneratedAt', 'ipLock', 'boundIp', 'bannedUsers', 'launchPaused']) {
                    if (Object.prototype.hasOwnProperty.call(current, field)) restored[field] = current[field];
                }
            } else {
                // A deleted vault may have had its credentials revoked after this
                // backup. Restore its script, but never resurrect historical keys.
                restored.keys = [];
                restored.key = null;
                restored.keyGeneratedAt = null;
                restored.ipLock = false;
                restored.boundIp = null;
                restored.bannedUsers = [];
            }
            await vaultRef.set(restored);

            const matchingRequests = await db.collection('restoreRequests').where('backupId', '==', backupId).get();
            const pendingRequests = matchingRequests.docs.filter(doc => {
                const item = doc.data();
                return ['pending', 'in_review', 'needs_admin'].includes(item.status) && (item.backupType === 'communityScript' ? 'communityScript' : 'vault') === 'vault';
            });
            if (pendingRequests.length) {
                const batch = db.batch();
                for (const request of pendingRequests) batch.update(request.ref, { status: 'restored', handledAt: now });
                await batch.commit();
            }
            return json(res, 200, { ok: true, backupType, vaultId: String(backup.vaultId), title: String(backup.title || 'Untitled Vault'), loaderVersion: nextVersion, recreated: !current });
        }

        if (action === 'dismiss_restore_request') {
            const requestId = String(body.requestId || '');
            if (!/^[A-Za-z0-9_-]{10,40}$/.test(requestId)) return json(res, 400, { ok: false, message: 'Choose a valid restore request.' });
            const requestRef = db.collection('restoreRequests').doc(requestId);
            const requestSnap = await requestRef.get();
            if (!requestSnap.exists) return json(res, 404, { ok: false, message: 'That restore request no longer exists.' });
            if (!['pending', 'in_review', 'needs_admin'].includes(String(requestSnap.data().status || 'pending'))) return json(res, 409, { ok: false, message: 'That restore request is already closed.' });
            await requestRef.update({ status: 'declined', handledAt: Date.now() });
            return json(res, 200, { ok: true });
        }

        if (action === 'approve_source_request') {
            const requestId = String(body.requestId || '');
            const adminNote = String(body.adminNote || '').trim().slice(0, 300);
            // How long the approval lasts — default 24 hours, max 7 days
            const accessHours = Math.min(Math.max(1, Number(body.accessHours) || 24), 168);
            if (!/^[A-Za-z0-9_-]{10,40}$/.test(requestId)) return json(res, 400, { ok: false, message: 'Choose a valid source access request.' });
            const ref = db.collection('sourceAccessRequests').doc(requestId);
            const snap = await ref.get();
            if (!snap.exists) return json(res, 404, { ok: false, message: 'That source access request no longer exists.' });
            if (snap.data().status !== 'pending') return json(res, 409, { ok: false, message: 'That request is already closed.' });
            const now = Date.now();
            const expiresAt = now + accessHours * 60 * 60 * 1000;
            await ref.update({ status: 'approved', adminNote, handledAt: now, handledBy: 'admin', expiresAt });
            return json(res, 200, { ok: true, requestId, expiresAt });
        }

        if (action === 'deny_source_request') {
            const requestId = String(body.requestId || '');
            const adminNote = String(body.adminNote || '').trim().slice(0, 300);
            if (!/^[A-Za-z0-9_-]{10,40}$/.test(requestId)) return json(res, 400, { ok: false, message: 'Choose a valid source access request.' });
            const ref = db.collection('sourceAccessRequests').doc(requestId);
            const snap = await ref.get();
            if (!snap.exists) return json(res, 404, { ok: false, message: 'That source access request no longer exists.' });
            if (snap.data().status !== 'pending') return json(res, 409, { ok: false, message: 'That request is already closed.' });
            await ref.update({ status: 'denied', adminNote, handledAt: Date.now(), handledBy: 'admin', expiresAt: null });
            return json(res, 200, { ok: true, requestId });
        }

        return json(res, 400, { ok: false, message: 'Choose a supported admin action.' });
    } catch (error) {
        console.error('Admin operations request failed:', error);
        return json(res, 500, { ok: false, message: 'Could not complete the admin operation.' });
    }
}
