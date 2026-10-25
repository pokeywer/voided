import { randomBytes } from 'node:crypto';
import { db, getAdminAuth } from './_admin.js';
import { getSourceForEditor } from './_deliveryCode.js';
import { sameOriginRequest } from './_adminSession.js';
import { createCommunityScriptBackup } from './_communityScriptBackups.js';

const SCOPES = new Set([
    'vaults', 'vaultSource', 'executions', 'announcements', 'announcementManage',
    'ideas', 'ideaTriage', 'restoreRequests', 'restoreTriage',
    'communityScripts', 'communityModeration'
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

function safeHttpUrl(value) {
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch { return null; }
}

function normalizeAnnouncement(item, fallbackId = '') {
    if (!item || typeof item !== 'object') return null;
    const title = String(item.title || '').slice(0, 80);
    const message = String(item.message || '').slice(0, 500);
    if (!title || !message) return null;
    return {
        id: String(item.id || fallbackId || randomBytes(12).toString('hex')),
        title,
        message,
        kind: ['info', 'success', 'warning'].includes(item.kind) ? item.kind : 'info',
        displayMode: item.displayMode === 'modal' ? 'modal' : 'banner',
        link: safeHttpUrl(String(item.link || '').trim()) || '',
        linkLabel: String(item.linkLabel || 'Learn more').slice(0, 32),
        dismissible: item.dismissible === true,
        expiresAt: Math.max(0, Number(item.expiresAt) || 0),
        enabled: item.enabled !== false,
        updatedAt: Math.max(0, Number(item.updatedAt) || 0)
    };
}

function announcementsFrom(data) {
    if (!data) return [];
    if (Array.isArray(data.announcements)) return data.announcements.map(item => normalizeAnnouncement(item)).filter(Boolean);
    const legacy = normalizeAnnouncement(data, 'legacy');
    return legacy ? [legacy] : [];
}

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

async function handleStaffAction(req, res, user, scopes) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');
    const email = String(user.email || '').slice(0, 254);

    if (action === 'save_announcement' || action === 'toggle_announcement') {
        if (!scopes.includes('announcements') || !scopes.includes('announcementManage')) return json(res, 403, { ok: false, message: 'Your grant does not allow announcement changes.' });
        const ref = db.collection('siteSettings').doc('announcement');
        const snap = await ref.get();
        const data = snap.exists ? snap.data() : null;
        const announcements = announcementsFrom(data);

        if (action === 'toggle_announcement') {
            const id = String(body.id || '');
            const index = announcements.findIndex(item => item.id === id);
            if (!id || index < 0) return json(res, 404, { ok: false, message: 'Announcement not found.' });
            if (typeof body.enabled !== 'boolean') return json(res, 400, { ok: false, message: 'Choose whether to activate or pause this announcement.' });
            const now = Date.now();
            const updated = { ...announcements[index], enabled: body.enabled, updatedAt: now, updatedBy: user.uid };
            const next = [...announcements];
            next[index] = updated;
            await ref.set({ announcements: next, updatedAt: now }, { merge: true });
            return json(res, 200, { ok: true, announcement: normalizeAnnouncement(updated), announcements: next.map(item => normalizeAnnouncement(item)).filter(Boolean) });
        }

        const id = String(body.id || '');
        const title = String(body.title || '').trim();
        const message = String(body.message || '').trim();
        const kind = String(body.kind || 'info');
        const displayMode = body.displayMode === 'modal' ? 'modal' : body.displayMode === 'banner' || body.displayMode === undefined ? 'banner' : null;
        const linkInput = String(body.link || '').trim();
        const link = safeHttpUrl(linkInput);
        const linkLabel = String(body.linkLabel || 'Learn more').trim();
        const expiresAtInput = body.expiresAt;
        const expiresAt = expiresAtInput === undefined || expiresAtInput === null || expiresAtInput === '' ? 0 : Number(expiresAtInput);
        if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json(res, 400, { ok: false, message: 'Choose a valid announcement.' });
        if (!title || title.length > 80) return json(res, 400, { ok: false, message: 'Title must be 1–80 characters.' });
        if (!message || message.length > 500) return json(res, 400, { ok: false, message: 'Message must be 1–500 characters.' });
        if (link === null) return json(res, 400, { ok: false, message: 'Link must be a valid http or https URL.' });
        if (linkLabel.length > 32) return json(res, 400, { ok: false, message: 'Link text must be 32 characters or fewer.' });
        if (!['info', 'success', 'warning'].includes(kind)) return json(res, 400, { ok: false, message: 'Choose a valid announcement style.' });
        if (!displayMode) return json(res, 400, { ok: false, message: 'Choose a valid announcement display.' });
        if (!Number.isFinite(expiresAt) || (expiresAt !== 0 && expiresAt <= Date.now())) return json(res, 400, { ok: false, message: 'Choose a future expiration time or leave it blank.' });

        const existingIndex = id ? announcements.findIndex(item => item.id === id) : -1;
        if (id && existingIndex < 0) return json(res, 404, { ok: false, message: 'Announcement not found.' });
        if (existingIndex < 0 && announcements.length >= 20) return json(res, 400, { ok: false, message: 'You can save up to 20 announcements.' });
        const now = Date.now();
        const announcement = {
            id: existingIndex >= 0 ? announcements[existingIndex].id : randomBytes(12).toString('hex'),
            title, message, kind, displayMode, link,
            linkLabel: link ? (linkLabel || 'Learn more') : '',
            dismissible: body.dismissible === true,
            expiresAt,
            enabled: body.enabled !== false,
            updatedAt: now,
            updatedBy: user.uid,
            updatedByEmail: email
        };
        const next = [...announcements];
        if (existingIndex >= 0) next[existingIndex] = announcement;
        else next.unshift(announcement);
        await ref.set({ announcements: next, updatedAt: now }, { merge: true });
        return json(res, 200, { ok: true, announcement: normalizeAnnouncement(announcement), announcements: next.map(item => normalizeAnnouncement(item)).filter(Boolean) });
    }

    if (action === 'update_idea_status') {
        if (!scopes.includes('ideas') || !scopes.includes('ideaTriage')) return json(res, 403, { ok: false, message: 'Your grant does not allow idea triage.' });
        const id = String(body.id || '');
        const status = String(body.status || '');
        if (!/^[A-Za-z0-9_-]{1,150}$/.test(id) || !['new', 'reviewed'].includes(status)) return json(res, 400, { ok: false, message: 'Choose a valid feature idea and status.' });
        const ref = db.collection('feature_requests').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, message: 'That feature idea no longer exists.' });
        const now = Date.now();
        await ref.update({ status, reviewedAt: status === 'reviewed' ? now : null, reviewedBy: status === 'reviewed' ? user.uid : null });
        return json(res, 200, { ok: true, id, status });
    }

    if (action === 'moderate_community_script') {
        if (!scopes.includes('communityScripts') || !scopes.includes('communityModeration')) return json(res, 403, { ok: false, message: 'Your grant does not allow community script moderation.' });
        const id = String(body.id || '');
        const status = String(body.status || '');
        const note = String(body.note || '').trim().slice(0, 300);
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(id) || !['approved', 'rejected'].includes(status)) return json(res, 400, { ok: false, message: 'Choose a valid community script review action.' });
        if (status === 'rejected' && note.length < 8) return json(res, 400, { ok: false, message: 'Add a short reason before rejecting a submission (at least 8 characters).'});
        const ref = db.collection('communityScripts').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, message: 'That community script no longer exists.' });
        if (snap.data().status !== 'pending') return json(res, 409, { ok: false, message: 'Another reviewer already handled this submission. Refresh the panel.' });
        await createCommunityScriptBackup(id, snap.data(), 'before_moderation', user.uid);
        await ref.update({
            status,
            moderatedAt: Date.now(),
            moderatedBy: `staff:${user.uid}`,
            moderatedByEmail: email,
            moderationNote: note
        });
        return json(res, 200, { ok: true, id, status });
    }

    if (action === 'triage_restore_request') {
        if (!scopes.includes('restoreRequests') || !scopes.includes('restoreTriage')) return json(res, 403, { ok: false, message: 'Your grant does not allow restore request triage.' });
        const id = String(body.id || '');
        const status = String(body.status || '');
        const note = String(body.note || '').trim().slice(0, 500);
        if (!/^[A-Za-z0-9_-]{10,40}$/.test(id) || !['in_review', 'needs_admin'].includes(status)) return json(res, 400, { ok: false, message: 'Choose a valid restore request action.' });
        if (status === 'needs_admin' && note.length < 8) return json(res, 400, { ok: false, message: 'Add a note for the administrator before escalating (at least 8 characters).'});
        const ref = db.collection('restoreRequests').doc(id);
        const now = Date.now();
        await db.runTransaction(async transaction => {
            const snap = await transaction.get(ref);
            if (!snap.exists) fail(404, 'That restore request no longer exists.');
            const item = snap.data();
            if (!['pending', 'in_review', 'needs_admin'].includes(String(item.status || 'pending'))) fail(409, 'This restore request is already closed.');
            const notes = Array.isArray(item.staffNotes) ? item.staffNotes.slice(-19) : [];
            if (note) notes.push({ uid: user.uid, email, text: note, createdAt: now });
            transaction.update(ref, {
                status,
                assignedStaffUid: user.uid,
                assignedStaffEmail: email,
                assignedAt: now,
                staffNotes: notes,
                adminReviewRequestedAt: status === 'needs_admin' ? now : (item.adminReviewRequestedAt || null),
                updatedAt: now
            });
        });
        return json(res, 200, { ok: true, id, status });
    }

    if (action === 'request_source_access') {
        if (!scopes.includes('vaultSource')) return json(res, 403, { ok: false, message: 'Your grant does not allow source access requests.' });
        const vaultId = String(body.vaultId || '');
        const reason = String(body.reason || '').trim().slice(0, 500);
        if (!/^[A-Za-z0-9_-]{1,150}$/.test(vaultId)) return json(res, 400, { ok: false, message: 'Choose a valid vault.' });
        if (reason.length < 8) return json(res, 400, { ok: false, message: 'Provide a reason for needing source access (at least 8 characters).' });
        // Check for an already-pending request for this staff+vault
        const existingSnap = await db.collection('sourceAccessRequests')
            .where('staffUid', '==', user.uid)
            .where('vaultId', '==', vaultId)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        if (!existingSnap.empty) return json(res, 200, { ok: true, requestId: existingSnap.docs[0].id, alreadyRequested: true });
        // Look up vault title for the admin panel display
        const vaultSnap = await db.collection('vaults').doc(vaultId).get();
        if (!vaultSnap.exists) return json(res, 404, { ok: false, message: 'That vault no longer exists.' });
        const vaultTitle = String(vaultSnap.data().title || 'Untitled Vault').slice(0, 80);
        const ref = db.collection('sourceAccessRequests').doc();
        await ref.create({
            staffUid: user.uid,
            staffEmail: email,
            vaultId,
            vaultTitle,
            reason,
            status: 'pending',
            createdAt: Date.now(),
            handledAt: null,
            adminNote: '',
            expiresAt: null
        });
        return json(res, 201, { ok: true, requestId: ref.id });
    }

    return json(res, 400, { ok: false, message: 'Choose a supported staff action.' });
}

export default async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (req.method === 'POST' && !sameOriginRequest(req)) return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    const user = await signedInUser(req);
    if (!user) return json(res, 401, { ok: false, message: 'Sign in to check staff access.' });

    try {
        const grantSnap = await db.collection('staffAccess').doc(user.uid).get();
        if (!grantSnap.exists) return json(res, 403, { ok: false, message: 'No staff access is assigned to this account.', uid: user.uid });
        const grant = grantSnap.data();
        const expiresAt = Number(grant.expiresAt);
        if (grant.active !== true || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return json(res, 403, { ok: false, message: 'Staff access is expired or has been disabled.', uid: user.uid });
        }
        if (grant.email && String(grant.email).toLowerCase() !== String(user.email || '').toLowerCase()) {
            return json(res, 403, { ok: false, message: 'This staff grant is tied to a different signed-in email.', uid: user.uid });
        }

        const scopes = Array.isArray(grant.scopes) ? [...new Set(grant.scopes.filter(scope => SCOPES.has(scope)))] : [];
        const dependencies = [
            ['vaultSource', 'vaults'], ['announcementManage', 'announcements'], ['ideaTriage', 'ideas'],
            ['restoreTriage', 'restoreRequests'], ['communityModeration', 'communityScripts']
        ];
        if (dependencies.some(([actionScope, viewScope]) => scopes.includes(actionScope) && !scopes.includes(viewScope))) {
            return json(res, 403, { ok: false, message: 'This staff grant is incomplete. Ask an administrator to include the required viewing permission.' });
        }
        if (req.method === 'POST') {
            try { return await handleStaffAction(req, res, user, scopes); }
            catch (error) {
                if (error.status) return json(res, error.status, { ok: false, message: error.message });
                throw error;
            }
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
        // Staff cannot access vault source directly — they must request it and have it approved by an admin.
        const requestedVaultId = String(req.query?.vaultId || '');
        if (scopes.includes('vaultSource') && requestedVaultId) {
            if (!/^[A-Za-z0-9_-]{1,150}$/.test(requestedVaultId)) return json(res, 400, { ok: false, message: 'Choose a valid vault.' });
            // Only serve source if there is an active admin-approved grant for this staff member + vault
            const approvedSnap = await db.collection('sourceAccessRequests')
                .where('staffUid', '==', user.uid)
                .where('vaultId', '==', requestedVaultId)
                .where('status', '==', 'approved')
                .limit(1)
                .get();
            if (approvedSnap.empty) {
                return json(res, 403, { ok: false, message: 'Source access for this vault has not been approved. Submit a request and wait for an administrator to approve it.', needsApproval: true });
            }
            const grantData = approvedSnap.docs[0].data();
            if (grantData.expiresAt && Number(grantData.expiresAt) <= Date.now()) {
                return json(res, 403, { ok: false, message: 'Your approved source access for this vault has expired. Submit a new request.', needsApproval: true });
            }
            const sourceSnap = await db.collection('vaults').doc(requestedVaultId).get();
            if (sourceSnap.exists) {
                const sourceData = sourceSnap.data();
                data.vaultSource = { id: sourceSnap.id, title: String(sourceData.title || 'Untitled Vault').slice(0, 80), source: getSourceForEditor(sourceData) };
            }
        }

        // Return this staff member's own source access requests so the panel can show statuses
        if (scopes.includes('vaultSource')) {
            const myRequestsSnap = await db.collection('sourceAccessRequests')
                .where('staffUid', '==', user.uid)
                .orderBy('createdAt', 'desc')
                .limit(20)
                .get();
            data.sourceAccessRequests = myRequestsSnap.docs.map(doc => {
                const item = doc.data();
                return {
                    id: doc.id,
                    vaultId: String(item.vaultId || ''),
                    vaultTitle: String(item.vaultTitle || 'Untitled Vault'),
                    reason: String(item.reason || ''),
                    status: String(item.status || 'pending'),
                    adminNote: String(item.adminNote || ''),
                    createdAt: Number(item.createdAt) || 0,
                    handledAt: Number(item.handledAt) || 0,
                    expiresAt: Number(item.expiresAt) || 0
                };
            });
        }
        if (scopes.includes('communityScripts') && req.query?.communityScriptId) {
            const scriptId = String(req.query.communityScriptId);
            if (!/^[A-Za-z0-9_-]{1,120}$/.test(scriptId)) return json(res, 400, { ok: false, message: 'Choose a valid community script.' });
            const scriptSnap = await db.collection('communityScripts').doc(scriptId).get();
            if (scriptSnap.exists && scriptSnap.data().status === 'pending') {
                const item = scriptSnap.data();
                data.communityScript = {
                    id: scriptSnap.id,
                    title: String(item.title || 'Untitled script').slice(0, 80),
                    description: String(item.description || '').slice(0, 400),
                    game: String(item.game || 'Any game').slice(0, 80),
                    category: String(item.category || 'Other').slice(0, 40),
                    authorName: String(item.authorName || 'Community member').slice(0, 32),
                    code: String(item.code || '').slice(0, 40000),
                    createdAt: Number(item.createdAt) || 0
                };
            }
        }
        if (scopes.includes('announcements')) {
            const snap = await db.collection('siteSettings').doc('announcement').get();
            const raw = snap.exists ? snap.data() : {};
            const items = announcementsFrom(raw);
            data.announcements = items.map(item => ({
                ...item,
                expired: !!item.expiresAt && item.expiresAt <= Date.now()
            }));
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
                    assignedStaffEmail: String(item.assignedStaffEmail || ''),
                    staffNotes: Array.isArray(item.staffNotes) ? item.staffNotes.slice(-8).map(note => ({ email: String(note.email || ''), text: String(note.text || '').slice(0, 500), createdAt: Number(note.createdAt) || 0 })) : [],
                    createdAt: Number(item.createdAt) || 0
                };
            });
        }
        if (scopes.includes('communityScripts')) {
            const snapshot = await db.collection('communityScripts').where('status', '==', 'pending').limit(50).get();
            data.communityScripts = snapshot.docs.map(doc => {
                const item = doc.data();
                return { id: doc.id, title: String(item.title || 'Untitled script').slice(0, 80), description: String(item.description || '').slice(0, 200), game: String(item.game || 'Any game').slice(0, 80), category: String(item.category || 'Other').slice(0, 40), authorName: String(item.authorName || 'Community member').slice(0, 32), createdAt: Number(item.createdAt) || 0 };
            }).sort((a, b) => b.createdAt - a.createdAt);
        }

        return json(res, 200, {
            ok: true,
            staff: { uid: user.uid, email: String(user.email || ''), isGuest: user.firebase?.sign_in_provider === 'anonymous', expiresAt, scopes },
            data
        });
    } catch (error) {
        console.error('Staff panel request failed:', error);
        return json(res, 500, { ok: false, message: 'Could not load or update staff data.' });
    }
}
