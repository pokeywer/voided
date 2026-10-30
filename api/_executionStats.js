import { db, FieldValue } from './_admin.js';
import { createHash, createHmac } from 'node:crypto';

function cleanText(value, max) {
    return String(value ?? '')
        .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, max);
}

function playerDocId(identity) {
    return createHash('sha256').update(identity).digest('hex').slice(0, 40);
}

// Dates use UTC so all visitors see the same daily and monthly cutoffs.
export async function recordExecution(vaultRef, vaultId, rawTitle, rawPlayerId = null, rawMeta = {}) {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);
    const title = typeof rawTitle === 'string' && rawTitle.trim()
        ? rawTitle.trim().slice(0, 120)
        : 'Untitled Vault';
    const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
    const country = /^[A-Z]{2}$/.test(String(meta.country || '')) ? String(meta.country) : null;
    const regionCode = String(meta.region || '').toUpperCase();
    const region = /^[A-Z0-9]{1,3}$/.test(regionCode) ? regionCode : null;
    const username = cleanText(meta.username, 32) || 'Unknown';
    const executor = cleanText(meta.executor, 40);
    const hwid = cleanText(meta.hwid, 96);
    const playerId = String(rawPlayerId || '').trim();

    const batch = db.batch();
    // Any successful run exempts the vault from the unused-script cleanup timer.
    const vaultUpdate = { executions: FieldValue.increment(1), autoDeleteAt: null };
    // A single map on the vault doc keeps the per-country totals readable
    // without a query; ISO-3166 alpha-2 keys are safe as field paths.
    if (country) vaultUpdate[`geo.${country}`] = FieldValue.increment(1);
    batch.update(vaultRef, vaultUpdate);
    batch.set(
        db.collection('leaderboardDaily').doc(dayKey).collection('vaults').doc(String(vaultId)),
        { vaultId: String(vaultId), title, executions: FieldValue.increment(1) },
        { merge: true }
    );
    batch.set(
        db.collection('leaderboardMonthly').doc(monthKey).collection('vaults').doc(String(vaultId)),
        { vaultId: String(vaultId), title, executions: FieldValue.increment(1) },
        { merge: true }
    );

    batch.set(
        db.collection('siteActivityDaily').doc(dayKey),
        { date: dayKey, executions: FieldValue.increment(1), updatedAt: now.getTime() },
        { merge: true }
    );

    // Keep a per-day unique player marker for an honest active-user estimate.
    // Only the server-side HMAC is stored; the submitted Roblox ID is discarded.
    const hashSecret = [
        process.env.ACTIVE_USER_HASH_SECRET,
        process.env.ADMIN_SESSION_SECRET,
        process.env.FIREBASE_SERVICE_ACCOUNT
    ].find(secret => typeof secret === 'string' && Buffer.byteLength(secret) >= 32) || '';
    if (/^\d{1,20}$/.test(playerId) && hashSecret) {
        const playerHash = createHmac('sha256', hashSecret).update(playerId).digest('hex');
        batch.set(
            db.collection('activeUsersDaily').doc(dayKey).collection('players').doc(playerHash),
            { lastSeenAt: now.getTime() },
            { merge: true }
        );
    }

    // One rolling document per player so the owner can see who is running the
    // vault, from where, and with which executor. The doc id is a hash so it
    // never depends on user-controlled characters.
    const identity = /^\d{1,20}$/.test(playerId)
        ? `u:${playerId}`
        : hwid
            ? `h:${hwid.toLowerCase()}`
            : username !== 'Unknown'
                ? `n:${username.toLowerCase()}`
                : '';
    if (identity) {
        batch.set(
            vaultRef.collection('players').doc(playerDocId(identity)),
            {
                username,
                userId: /^\d{1,20}$/.test(playerId) ? playerId : null,
                executor: executor || null,
                hwid: hwid || null,
                country,
                region,
                runs: FieldValue.increment(1),
                lastSeenAt: now.getTime()
            },
            { merge: true }
        );
    }
    await batch.commit();
}

// Lets a downloaded client wrapper report its Roblox ID without exposing it
// in the public launcher URL. Only a server-side HMAC is stored.
export async function recordActiveUser(rawPlayerId) {
    const playerId = String(rawPlayerId || '').trim();
    if (!/^\d{1,20}$/.test(playerId)) return false;

    const hashSecret = [
        process.env.ACTIVE_USER_HASH_SECRET,
        process.env.ADMIN_SESSION_SECRET,
        process.env.FIREBASE_SERVICE_ACCOUNT
    ].find(secret => typeof secret === 'string' && Buffer.byteLength(secret) >= 32) || '';
    if (!hashSecret) return false;

    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const playerHash = createHmac('sha256', hashSecret).update(playerId).digest('hex');
    await db.collection('activeUsersDaily').doc(dayKey).collection('players').doc(playerHash).set(
        { lastSeenAt: now.getTime() },
        { merge: true }
    );
    return true;
}
