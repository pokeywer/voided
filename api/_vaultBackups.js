import { db } from './_admin.js';

const MAX_BACKUPS_PER_VAULT = 20;
const BACKUP_CHUNK_BYTES = 512 * 1024;
const MAX_BACKUP_JSON_BYTES = 6 * 1024 * 1024;

export async function createVaultBackup(vaultId, vaultData, reason, actorUid = '') {
    if (!vaultData || typeof vaultData !== 'object' || !vaultData.uid) {
        throw new Error('The vault backup is missing its owner or saved data.');
    }

    const ref = db.collection('vaultBackups').doc();
    const serialized = Buffer.from(JSON.stringify(vaultData), 'utf8');
    if (!serialized.length || serialized.length > MAX_BACKUP_JSON_BYTES) {
        throw new Error('This vault is too large to back up safely.');
    }
    const chunks = [];
    for (let offset = 0; offset < serialized.length; offset += BACKUP_CHUNK_BYTES) {
        chunks.push(serialized.subarray(offset, Math.min(offset + BACKUP_CHUNK_BYTES, serialized.length)).toString('base64'));
    }
    const backup = {
        vaultId: String(vaultId),
        ownerUid: String(vaultData.uid),
        title: String(vaultData.title || 'Untitled Vault').slice(0, 80),
        createdAt: Date.now(),
        reason: ['before_save', 'before_delete', 'before_restore'].includes(reason) ? reason : 'before_save',
        actorUid: String(actorUid || '').slice(0, 128),
        storageVersion: 2,
        chunkCount: chunks.length
    };
    const batch = db.batch();
    batch.create(ref, backup);
    chunks.forEach((data, index) => {
        batch.create(ref.collection('chunks').doc(String(index).padStart(4, '0')), { index, data });
    });
    await batch.commit();

    try { await pruneVaultBackups(String(vaultId)); } catch (error) {
        console.error('Could not prune old vault backups:', error);
    }
    return { id: ref.id, ...backup };
}

export async function readVaultBackupData(backupRef, backup) {
    if (backup?.data && typeof backup.data === 'object' && !Array.isArray(backup.data)) return backup.data;
    const chunkCount = Number(backup?.chunkCount);
    if (Number(backup?.storageVersion) !== 2 || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 32) return null;

    const snapshot = await backupRef.collection('chunks').orderBy('index', 'asc').get();
    if (snapshot.size !== chunkCount) return null;
    const pieces = [];
    let totalBytes = 0;
    for (const doc of snapshot.docs) {
        const item = doc.data();
        if (Number(item.index) !== pieces.length || typeof item.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) return null;
        const piece = Buffer.from(item.data, 'base64');
        totalBytes += piece.length;
        if (totalBytes > MAX_BACKUP_JSON_BYTES) return null;
        pieces.push(piece);
    }
    try {
        const decoded = JSON.parse(Buffer.concat(pieces, totalBytes).toString('utf8'));
        return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
    } catch { return null; }
}

export async function pruneVaultBackups(vaultId) {
    const [backupSnap, pendingSnap] = await Promise.all([
        db.collection('vaultBackups').where('vaultId', '==', vaultId).get(),
        db.collection('restoreRequests').where('status', 'in', ['pending', 'in_review', 'needs_admin']).get()
    ]);
    if (backupSnap.size <= MAX_BACKUPS_PER_VAULT) return;

    const pendingIds = new Set(pendingSnap.docs.map(doc => String(doc.data().backupId || '')));
    const newestFirst = backupSnap.docs.sort((a, b) => Number(b.data().createdAt || 0) - Number(a.data().createdAt || 0));
    const keep = new Set(newestFirst.slice(0, MAX_BACKUPS_PER_VAULT).map(doc => doc.id));
    const deletions = newestFirst.filter(doc => !keep.has(doc.id) && !pendingIds.has(doc.id));
    let batch = db.batch();
    let operationCount = 0;
    const flush = async () => {
        if (!operationCount) return;
        await batch.commit();
        batch = db.batch();
        operationCount = 0;
    };
    for (const doc of deletions) {
        const chunks = await doc.ref.collection('chunks').get();
        for (const chunk of chunks.docs) {
            batch.delete(chunk.ref);
            operationCount += 1;
            if (operationCount >= 450) await flush();
        }
        batch.delete(doc.ref);
        operationCount += 1;
        if (operationCount >= 450) await flush();
    }
    await flush();
}

