import { db } from './_admin.js';

// Void tokens are a daily allowance plus an admin-granted bonus. The daily part
// refills at 00:00 UTC and never banks; bonus tokens only leave when granted or
// spent, so an admin grant is not lost by waiting.
export const DAILY_TOKEN_LIMIT = 8;
const COLLECTION = 'obfuscationTokens';
const MAX_GRANT = 10000;

function tokenError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

export function utcDay(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

export function nextResetAt(now = Date.now()) {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function discordSubject(discordUserId) {
    const id = String(discordUserId || '').trim();
    if (!/^\d{17,20}$/.test(id)) throw tokenError('That Discord user ID is not valid.', 400);
    return `discord:${id}`;
}

export function websiteSubject(uid) {
    const id = String(uid || '').trim();
    if (!/^[A-Za-z0-9:_-]{6,128}$/.test(id)) throw tokenError('That account ID is not valid.', 400);
    return `web:${id}`;
}

// Admin input: a 17-20 digit number is a Discord user, anything else is treated
// as a VoidedX (Firebase) account ID.
export function subjectFromAdminInput(raw) {
    const value = String(raw || '').trim();
    if (!value) throw tokenError('Enter a Discord user ID or a VoidedX account ID.', 400);
    return /^\d{17,20}$/.test(value) ? `discord:${value}` : websiteSubject(value.replace(/^web:/, ''));
}

export function summarizeTokens(data, now = Date.now()) {
    const day = utcDay(now);
    const usedToday = data && data.dailyDay === day ? Math.max(0, Math.floor(Number(data.dailyUsed) || 0)) : 0;
    const dailyRemaining = Math.max(0, DAILY_TOKEN_LIMIT - usedToday);
    const bonus = Math.max(0, Math.floor(Number(data?.bonus) || 0));
    return {
        remaining: dailyRemaining + bonus,
        dailyRemaining,
        dailyLimit: DAILY_TOKEN_LIMIT,
        usedToday,
        bonus,
        resetsAt: nextResetAt(now)
    };
}

export async function readTokens(subject) {
    const snap = await db.collection(COLLECTION).doc(subject).get();
    return { subject, ...summarizeTokens(snap.exists ? snap.data() : null) };
}

export async function consumeTokens(subject) {
    const ref = db.collection(COLLECTION).doc(subject);
    return db.runTransaction(async transaction => {
        const now = Date.now();
        const snap = await transaction.get(ref);
        const data = snap.exists ? snap.data() : {};
        const day = utcDay(now);
        const usedToday = data.dailyDay === day ? Math.max(0, Math.floor(Number(data.dailyUsed) || 0)) : 0;
        const bonus = Math.max(0, Math.floor(Number(data.bonus) || 0));

        if (usedToday >= DAILY_TOKEN_LIMIT && bonus <= 0) {
            const error = tokenError('All 8 void tokens for today are used. They reset at midnight UTC.', 429);
            error.resetsAt = nextResetAt(now);
            throw error;
        }

        const fromDaily = usedToday < DAILY_TOKEN_LIMIT;
        const next = {
            subject,
            dailyDay: day,
            dailyUsed: fromDaily ? usedToday + 1 : usedToday,
            bonus: fromDaily ? bonus : bonus - 1,
            totalUsed: Math.max(0, Math.floor(Number(data.totalUsed) || 0)) + 1,
            updatedAt: now
        };
        transaction.set(ref, next, { merge: true });
        return { subject, ...summarizeTokens(next, now) };
    });
}

export async function grantTokens(subject, amount) {
    const delta = Math.floor(Number(amount));
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_GRANT) {
        throw tokenError('Enter a whole number of tokens between -10000 and 10000.', 400);
    }
    const ref = db.collection(COLLECTION).doc(subject);
    return db.runTransaction(async transaction => {
        const now = Date.now();
        const snap = await transaction.get(ref);
        const data = snap.exists ? snap.data() : {};
        const bonus = Math.max(0, Math.floor(Number(data.bonus) || 0) + delta);
        transaction.set(ref, {
            subject,
            bonus,
            dailyDay: data.dailyDay || utcDay(now),
            dailyUsed: Math.max(0, Math.floor(Number(data.dailyUsed) || 0)),
            updatedAt: now
        }, { merge: true });
        return { subject, granted: bonus - Math.max(0, Math.floor(Number(data.bonus) || 0)), ...summarizeTokens({ ...data, bonus }, now) };
    });
}
