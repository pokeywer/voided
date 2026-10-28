import { randomBytes } from 'node:crypto';
import { db } from './_admin.js';
import {
    DAILY_TOKEN_LIMIT, consumeTokens, discordSubject, readTokens, summarizeTokens
} from './_obfuscationTokens.js';

export const OBFUSCATION_DAILY_TOKENS = DAILY_TOKEN_LIMIT;
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

// The link only carries identity and a preloaded source. The allowance lives in
// the token ledger, so a second /obfuscate keeps the same daily balance instead
// of minting a fresh batch.
export async function createDiscordObfuscationSession({ discordUserId, discordUsername, source, level, filename }) {
    const subject = discordSubject(discordUserId);
    const now = Date.now();
    const username = String(discordUsername || '').trim().slice(0, 64);
    const nextSource = typeof source === 'string' ? source.slice(0, MAX_SESSION_SOURCE_CHARS) : '';
    const nextLevel = cleanLevel(String(level || 'auto'));
    const nextFilename = cleanFilename(filename);
    const tokens = await readTokens(subject);

    const ownerRef = db.collection(OWNER_COLLECTION).doc(String(discordUserId).trim());
    const ownerSnap = await ownerRef.get();
    const pointer = ownerSnap.exists ? ownerSnap.data() : null;

    if (pointer && isValidObfuscationToken(pointer.token) && Number(pointer.expiresAt) > now) {
        const sessionRef = db.collection(COLLECTION).doc(pointer.token);
        const sessionSnap = await sessionRef.get();
        if (sessionSnap.exists && Number(sessionSnap.data().expiresAt) > now) {
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
                credits: tokens.remaining,
                dailyLimit: tokens.dailyLimit,
                resetsAt: tokens.resetsAt,
                expiresAt: Number(sessionSnap.data().expiresAt) || 0,
                reused: true
            };
        }
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = now + OBFUSCATION_SESSION_TTL_MS;
    await db.collection(COLLECTION).doc(token).set({
        discordUserId: String(discordUserId).trim(),
        subject,
        discordUsername: username,
        initialSource: nextSource,
        initialLevel: nextLevel,
        filename: nextFilename,
        createdAt: now,
        updatedAt: now,
        expiresAt
    });
    await ownerRef.set({ token, expiresAt, subject, createdAt: now, updatedAt: now });
    const previousToken = pointer?.token;
    if (isValidObfuscationToken(previousToken) && previousToken !== token) {
        await db.collection(COLLECTION).doc(previousToken).delete().catch(() => {});
    }

    return {
        token,
        credits: tokens.remaining,
        dailyLimit: tokens.dailyLimit,
        resetsAt: tokens.resetsAt,
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

export async function sessionTokens(session) {
    if (!session) return summarizeTokens(null);
    try {
        return (await readTokens(session.subject || discordSubject(session.discordUserId)));
    } catch {
        return summarizeTokens(null);
    }
}

export async function consumeObfuscationToken(token) {
    const session = await getObfuscationSession(token);
    if (!session) throw sessionError('This obfuscation link is invalid or has expired. Run /obfuscate again in Discord.', 404);

    const subject = session.subject || discordSubject(session.discordUserId);
    const result = await consumeTokens(subject);
    await db.collection(COLLECTION).doc(token).update({ lastUsedAt: Date.now() }).catch(() => {});
    return result;
}
