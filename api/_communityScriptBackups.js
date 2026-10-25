import { db } from './_admin.js';

const MAX_BACKUPS_PER_SCRIPT = 20;
const BACKUP_REASONS = new Set(['before_delete', 'before_moderation', 'before_restore']);

export async function createCommunityScriptBackup(scriptId, scriptData, reason, actorUid = '') {
    if (!scriptData || typeof scriptData !== 'object' || !scriptData.ownerUid) {
        throw new Error('The community script backup is missing its owner or saved data.');
    }

    const backupRef = db.collection('communityScriptBackups').doc();
    const backup = {
        scriptId: String(scriptId),
        ownerUid: String(scriptData.ownerUid),
        title: String(scriptData.title || 'Untitled script').slice(0, 80),
        createdAt: Date.now(),
        reason: BACKUP_REASONS.has(reason) ? reason : 'before_delete',
        actorUid: String(actorUid || '').slice(0, 128),
        data: scriptData
    };
    await backupRef.create(backup);

    try { await pruneCommunityScriptBackups(String(scriptId)); } catch (error) {
        console.error('Could not prune old community script backups:', error);
    }
    return { id: backupRef.id, ...backup, data: undefined };
}

async function pruneCommunityScriptBackups(scriptId) {
    const [backups, requests] = await Promise.all([
        db.collection('communityScriptBackups').where('scriptId', '==', scriptId).get(),
        db.collection('restoreRequests').where('status', '==', 'pending').get()
    ]);
    if (backups.size <= MAX_BACKUPS_PER_SCRIPT) return;

    const pendingIds = new Set(requests.docs
        .filter(doc => doc.data().backupType === 'communityScript')
        .map(doc => String(doc.data().backupId || '')));
    const newestFirst = backups.docs.sort((a, b) => Number(b.data().createdAt || 0) - Number(a.data().createdAt || 0));
    const keep = new Set(newestFirst.slice(0, MAX_BACKUPS_PER_SCRIPT).map(doc => doc.id));
    const deletions = newestFirst.filter(doc => !keep.has(doc.id) && !pendingIds.has(doc.id));
    const batches = [];
    for (let offset = 0; offset < deletions.length; offset += 450) {
        const batch = db.batch();
        for (const doc of deletions.slice(offset, offset + 450)) batch.delete(doc.ref);
        batches.push(batch.commit());
    }
    await Promise.all(batches);
}
