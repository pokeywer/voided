import { createHash } from 'node:crypto';

// Void tokens belong to a person, not to a sign-in session. The ledger stays
// keyed by `web:<firebaseUid>`, but every account that proves the same verified
// email resolves to the first one, so signing out and back in (or switching
// between password, Google, and Discord) can never mint a fresh daily batch.
export const EMAIL_ALIAS_COLLECTION = 'obfuscationTokenAliases';
const EMAIL_HASH_LENGTH = 32;

export function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (email.length < 5 || email.length > 254) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
    return email;
}

export function emailAliasId(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return '';
    return createHash('sha256').update(normalized).digest('hex').slice(0, EMAIL_HASH_LENGTH);
}

// Password accounts can claim any address until they verify it, so only trust
// their email once Firebase marks it verified. Federated providers (Google,
// Discord, GitHub, ...) verify the address on their side before handing it over.
export function trustedEmail(user) {
    const email = normalizeEmail(user?.email);
    if (!email) return '';
    if (user?.email_verified === true) return email;
    const provider = String(user?.firebase?.sign_in_provider || '').trim();
    return provider && provider !== 'password' && provider !== 'anonymous' ? email : '';
}

function whole(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}

// Two ledgers for one person are folded together without ever handing back a
// spent token: the higher same-day usage wins, grants add up, and the audit
// counter keeps the larger total.
export function mergeLedgerUsage(target, source, day) {
    const usedToday = data => (data && data.dailyDay === day ? whole(data.dailyUsed) : 0);
    return {
        dailyDay: day,
        dailyUsed: Math.max(usedToday(target), usedToday(source)),
        bonus: whole(target?.bonus) + whole(source?.bonus),
        totalUsed: Math.max(whole(target?.totalUsed), whole(source?.totalUsed))
    };
}
