import { randomBytes } from 'node:crypto';
import { db } from './_admin.js';

export const OBFUSCATION_SESSION_CREDITS = 5;
export const OBFUSCATION_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_SOURCE_CHARS = 200_000;
const COLLECTION = 'obfuscationSessions';
const OWNER_COLLECTION = 'obfuscationSessionOwners';

export function isValidObfuscationToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(value);
}

function sessionError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function cleanLevel(value) {
    return ['auto', 'fast', 'low', 'medium', 'high', 'absolute'].includes(value) ? value : 'auto';
}

function cleanFilename(value) {
    const name = typeof value === 'string' ? value.trim().replace(/[\\/\r\n\u0000]/g, '') : '';
    return (name || 'script.lua').slice(0, 120);
}

export async function createDiscordObfuscationSession({ discordUserId, discordUsername, source, level, filename }) {
    const userId = String(discordUserId || '').trim();
    if (!/^\d{17,20}$/.test(userId)) throw sessionError('Discord user ID was missing.', 400);

    const now = Date.now();
    const username = String(discordUsername || '').trim().slice(0, 64);
    const nextSource = typeof source === 'string' ? source.slice(0, MAX_SESSION_SOURCE_CHARS) : '';
    const nextLevel = cleanLevel(String(level || 'auto'));
    const nextFilename = cleanFilename(filename);

    // One active link per Discord user. The pointer avoids a composite-index
    // query and keeps re-running /obfuscate from farming unlimited tokens.
    const ownerRef = db.collection(OWNER_COLLECTION).doc(userId);
    const ownerSnap = await ownerRef.get();
    const pointer = ownerSnap.exists ? ownerSnap.data() : null;

    if (pointer && isValidObfuscationToken(pointer.token) && Number(pointer.expiresAt) > now) {
        const sessionRef = db.collection(COLLECTION).doc(pointer.token);
        const sessionSnap = await sessionRef.get();
        if (sessionSnap.exists) {
            const data = sessionSnap.data();
            const activeCredits = Math.max(0, Number(data.credits) || 0);
            if (Number(data.expiresAt) > now && activeCredits > 0) {
                const updates = { discordUsername: username, updatedAt: now };
                if (nextSource) {
                    updates.initialSource = nextSource;
                    updates.initialLevel = nextLevel;
                    updates.filename = nextFilename;
                    updates.sourceUpdatedAt = now;
                }
                await sessionRef.update(updates);
                return {
                    token: pointer.token,
                    credits: activeCredits,
                    expiresAt: Number(data.expiresAt) || 0,
                    reused: true
                };
            }
        }
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = now + OBFUSCATION_SESSION_TTL_MS;
    await db.collection(COLLECTION).doc(token).set({
        discordUserId: userId,
        discordUsername: username,
        credits: OBFUSCATION_SESSION_CREDITS,
        initialSource: nextSource,
        initialLevel: nextLevel,
        filename: nextFilename,
        createdAt: now,
        updatedAt: now,
        expiresAt
    });
    await ownerRef.set({ token, expiresAt, createdAt: now, updatedAt: now });
    const previousToken = pointer?.token;
    if (isValidObfuscationToken(previousToken) && previousToken !== token) {
        await db.collection(COLLECTION).doc(previousToken).delete().catch(() => {});
    }

    return {
        token,
        credits: OBFUSCATION_SESSION_CREDITS,
        expiresAt,
        reused: false
    };
}

export async function getObfuscationSession(token) {
    if (!isValidObfuscationToken(token)) return null;
    const ref = db.collection(COLLECTION).doc(token);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (Number(data.expiresAt) <= Date.now()) {
        await ref.delete().catch(() => {});
        return null;
    }
    return { id: snap.id, ...data };
}

export async function consumeObfuscationToken(token) {
    if (!isValidObfuscationToken(token)) throw sessionError('This obfuscation link is not valid.', 400);
    const ref = db.collection(COLLECTION).doc(token);

    return db.runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw sessionError('This obfuscation link is invalid or has expired. Run /obfuscate again in Discord.', 404);

        const data = snap.data();
        if (Number(data.expiresAt) <= Date.now()) {
            throw sessionError('This obfuscation link has expired. Run /obfuscate again in Discord.', 410);
        }

        const credits = Math.max(0, Number(data.credits) || 0);
        if (credits <= 0) {
            throw sessionError('You have used all 5 void tokens on this link. Run /obfuscate again in Discord.', 403);
        }

        const remaining = credits - 1;
        transaction.update(ref, {
            credits: remaining,
            updatedAt: Date.now(),
            lastUsedAt: Date.now()
        });
        return { credits: remaining };
    });
}
