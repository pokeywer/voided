import { db } from './_admin.js';

const MAX_BACKUPS_PER_VAULT = 20;

export async function createVaultBackup(vaultId, vaultData, reason, actorUid = '') {
    if (!vaultData || typeof vaultData !== 'object' || !vaultData.uid) {
        throw new Error('The vault backup is missing its owner or saved data.');
    }

    const ref = db.collection('vaultBackups').doc();
    const backup = {
        vaultId: String(vaultId),
        ownerUid: String(vaultData.uid),
        title: String(vaultData.title || 'Untitled Vault').slice(0, 80),
        createdAt: Date.now(),
        reason: ['before_save', 'before_delete', 'before_restore'].includes(reason) ? reason : 'before_save',
        actorUid: String(actorUid || '').slice(0, 128),
        data: vaultData
    };
    await ref.create(backup);

    try { await pruneVaultBackups(String(vaultId)); } catch (error) {
        console.error('Could not prune old vault backups:', error);
    }
    return { id: ref.id, ...backup, data: undefined };
}

export async function pruneVaultBackups(vaultId) {
    const [backupSnap, pendingSnap] = await Promise.all([
        db.collection('vaultBackups').where('vaultId', '==', vaultId).get(),
        db.collection('restoreRequests').where('status', '==', 'pending').get()
    ]);
    if (backupSnap.size <= MAX_BACKUPS_PER_VAULT) return;

    const pendingIds = new Set(pendingSnap.docs.map(doc => String(doc.data().backupId || '')));
    const newestFirst = backupSnap.docs.sort((a, b) => Number(b.data().createdAt || 0) - Number(a.data().createdAt || 0));
    const keep = new Set(newestFirst.slice(0, MAX_BACKUPS_PER_VAULT).map(doc => doc.id));
    const deletions = newestFirst.filter(doc => !keep.has(doc.id) && !pendingIds.has(doc.id));
    const batches = [];
    for (let offset = 0; offset < deletions.length; offset += 450) {
        const batch = db.batch();
        for (const doc of deletions.slice(offset, offset + 450)) batch.delete(doc.ref);
        batches.push(batch.commit());
    }
    await Promise.all(batches);
}

