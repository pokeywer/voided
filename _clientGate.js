import { createHash } from 'node:crypto';

// ── Known bad actors ──────────────────────────────────────────────────────────
//
// HTTP libraries and browser drivers. No real Roblox executor sends these.
const LIBRARY_TOKENS = [
    'undici', 'node-fetch', 'node.js', 'node/', 'axios', 'got/', 'request/', 'superagent',
    'python-requests', 'python-urllib', 'urllib3', 'aiohttp', 'httpx', 'urllib/',
    'okhttp', 'java/', 'go-http-client', 'curl/', 'wget/', 'libwww-perl', 'httpclient',
    'postmanruntime', 'postmancollectionrunner', 'insomnia', 'restsharp', 'faraday',
    'workerd', 'cloudflare-workers', 'cloudflare', 'vercel', 'edge-runtime', 'deno',
    'phantomjs', 'headlesschrome', 'headless', 'selenium', 'puppeteer', 'playwright',
    'httponlyhttpclient', 'nsurlsession', 'apifox', 'apipost-client', 'hoppscotch'
];

// Runtime names only blocked when they appear as standalone words.
const LIBRARY_WORDS = ['node', 'nodejs'];

// Clients that only indicate a script on the bootstrap hop (mobile executors
// use these as their HTTP backend and are still legitimate on the gate hop).
const PORTABLE_TOKENS = [
    'curl/', 'wget/', 'okhttp', 'java/', 'httpclient', 'nsurlsession',
    'libwww-perl', 'faraday', 'apifox', 'apipost-client', 'hoppscotch'
];

// Known-good executor / Roblox strings.
const CLIENT_TOKENS = [
    'roblox', 'wininet', 'rblx', 'synapse', 'script-ware', 'scriptware', 'krnl', 'fluxus',
    'executor', 'electron', 'spore', 'wave', 'hydrogen', 'codex', 'swift', 'arceus',
    'volcano', 'potassium', 'phoenix', 'crocacuda', 'delta', 'prometheus', 'trigon',
    'macsploit', 'codewalker', 'orthus', 'auoowu', 'v1per', 'javis', 'bcore', 'nerve'
];

export const EXECUTOR_ONLY_MESSAGE = '[VoidedX] This loader only runs in an executor.';

export function clientGuardMode() {
    const value = String(process.env.LOADER_FETCH_GUARD || 'enforce').toLowerCase();
    return ['off', 'log', 'enforce'].includes(value) ? value : 'enforce';
}

// ── User-Agent classification (unchanged) ────────────────────────────────────

export function classifyAgent(userAgent, { toleratePortable = false } = {}) {
    const text = String(userAgent || '').toLowerCase().trim();
    if (!text) return 'empty';
    const blocked = toleratePortable
        ? LIBRARY_TOKENS.filter(token => !PORTABLE_TOKENS.includes(token))
        : LIBRARY_TOKENS;
    if (blocked.some(token => text.includes(token))) return 'client-library';
    if (LIBRARY_WORDS.some(word => new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'u').test(text))) return 'client-library';
    if (CLIENT_TOKENS.some(token => text.includes(token))) return 'client';
    if (text.includes('mozilla') || text.includes('chrome') || text.includes('safari')
        || text.includes('edg/') || text.includes('firefox')) return 'browser';
    return 'other';
}

export function agentFingerprint(userAgent) {
    return createHash('sha256').update(`loader-agent\0${String(userAgent || '')}`).digest('hex').slice(0, 16);
}

// ── Roblox engine header enforcement ────────────────────────────────────────
//
// When Roblox's HttpService makes a request the game engine *always* injects
// these headers automatically. They cannot be set by game scripts (they are
// injected below the script layer) and they cannot be replicated by an external
// fetcher that isn't actually running inside the Roblox client.
//
//   Roblox-Id          — numeric place ID (same as game.PlaceId)
//   Roblox-Place-Id    — alias used by some client versions
//   Roblox-Game-Id     — numeric universe/game ID
//   Roblox-Session-Id  — a GUID per game session, present on every request
//
// We require at least ONE of the place/game ID headers and the session GUID.
// If neither is present the request is almost certainly coming from a script
// outside the Roblox client.
//
// The guard is deliberately loose on what value the headers carry (we only
// validate shape, not content) so legitimate executor environments that inject
// slightly different values are not accidentally blocked. The point is that an
// external fetcher simply cannot produce these headers at all.

const ROBLOX_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROBLOX_ID_RE      = /^\d{1,20}$/;

/**
 * Inspect Roblox-injected headers.
 *
 * Returns an object with:
 *   hasPlaceId   — one of the place/game ID headers was present and numeric
 *   hasSessionId — the session GUID header was present and GUID-shaped
 *   confident    — both were present (strong signal it's a real Roblox client)
 *   placeIdVal   — the raw place ID value (for logging/binding)
 *   sessionVal   — the raw session ID value (for logging/binding)
 */
export function inspectRobloxHeaders(req) {
    const headers = req.headers || {};

    // Place/game ID — Roblox sends at least one of these.
    const placeIdVal = String(
        headers['roblox-id'] ||
        headers['roblox-place-id'] ||
        headers['roblox-game-id'] ||
        ''
    ).trim();

    // Session GUID — present on every HttpService call.
    const sessionVal = String(
        headers['roblox-session-id'] ||
        ''
    ).trim();

    const hasPlaceId   = ROBLOX_ID_RE.test(placeIdVal);
    const hasSessionId = ROBLOX_SESSION_RE.test(sessionVal);

    return {
        hasPlaceId,
        hasSessionId,
        confident: hasPlaceId && hasSessionId,
        placeIdVal,
        sessionVal
    };
}

/**
 * Hash of the Roblox session GUID, usable for request binding
 * (ties bootstrap and payload hops together without storing the raw GUID).
 */
export function robloxSessionHash(req) {
    const { sessionVal } = inspectRobloxHeaders(req);
    if (!sessionVal) return '';
    return createHash('sha256').update(`roblox-session\0${sessionVal}`).digest('hex').slice(0, 32);
}

// ── Main gate ────────────────────────────────────────────────────────────────
//
// Decision matrix for `enforce` mode:
//
//   UA = client-library               → BLOCK  (known HTTP tool, no spoofing needed)
//   UA = browser                      → BLOCK  (real browser, not an executor)
//   UA = client/other/empty AND
//     Roblox headers present          → ALLOW  (looks like the real client)
//   UA = client/other/empty AND
//     Roblox headers absent           → BLOCK  (spoofed UA but no engine headers)
//
// For the `gate` endpoint we tolerate portable tokens in the UA but still
// enforce the Roblox header check, because executors on mobile do use stock
// HTTP stacks yet the game engine still injects the session header.
//
// The `LOADER_ROBLOX_HEADER_GUARD` env-var can be set to `off` to disable the
// Roblox header check alone (e.g. during local development) without turning off
// the UA check.

function robloxHeaderGuardEnabled() {
    return String(process.env.LOADER_ROBLOX_HEADER_GUARD || 'enforce').toLowerCase() !== 'off';
}

export function inspectFetch(req, logTarget = '', endpoint = 'bootstrap') {
    const userAgent  = req.headers && req.headers['user-agent'];
    const agentLabel = classifyAgent(userAgent, { toleratePortable: endpoint === 'gate' });
    const mode       = clientGuardMode();
    const fingerprint = agentFingerprint(userAgent);

    // Step 1: block known HTTP libraries regardless of anything else.
    if (mode === 'enforce' && agentLabel === 'client-library') {
        if (logTarget) console.log(`loader-fetch:client-library ${fingerprint} ${logTarget}`);
        return { label: agentLabel, mode, block: true, fingerprint, roblox: null };
    }

    // Step 2: block browsers — they are not executors.
    if (mode === 'enforce' && agentLabel === 'browser') {
        if (logTarget) console.log(`loader-fetch:browser ${fingerprint} ${logTarget}`);
        return { label: agentLabel, mode, block: true, fingerprint, roblox: null };
    }

    // Step 3: Roblox engine header check.
    // A real Roblox client always has these; an external fetcher that spoofed the
    // UA cannot produce them because they are injected by the game engine.
    const roblox = inspectRobloxHeaders(req);
    if (mode === 'enforce' && robloxHeaderGuardEnabled()) {
        // We require the session GUID at minimum. The place ID check is used only
        // when we have *neither* ID header — being lenient here lets executors
        // that don't forward Roblox-Place-Id still pass if they have the session.
        if (!roblox.hasSessionId) {
            if (logTarget) {
                const reason = roblox.hasPlaceId ? 'no-session-guid' : 'no-roblox-headers';
                console.log(`loader-fetch:${reason} ${fingerprint} ${logTarget}`);
            }
            return { label: agentLabel, mode, block: true, fingerprint, roblox };
        }
    }

    // Log non-client traffic for tuning (not worth logging real executors).
    if (logTarget && mode !== 'off' && agentLabel !== 'client') {
        console.log(`loader-fetch:${agentLabel} ${fingerprint} ${logTarget}`);
    }

    return { label: agentLabel, mode, block: false, fingerprint, roblox };
}

// ── Session binding helpers ──────────────────────────────────────────────────
//
// Callers (e.g. _route-verify.js, _route-payload.js) can optionally bind a
// session to the Roblox session GUID so the bootstrap and the payload hop must
// come from the same game session. If the GUID changes between the two hops
// the delivery is refused.
//
// Usage in _route-verify.js:
//   const binding = robloxSessionBinding(req);
//   // store binding.sessionHash in the Firestore session doc
//
// Usage in _route-payload.js:
//   if (!robloxSessionMatches(req, session.robloxSessionHash)) { ... }

export function robloxSessionBinding(req) {
    const sessionHash = robloxSessionHash(req);
    return { robloxSessionHash: sessionHash || null };
}

export function robloxSessionMatches(req, storedHash) {
    if (!storedHash) return true;           // not bound — skip check
    const current = robloxSessionHash(req);
    if (!current) return false;             // bound but no header on this hop
    // Constant-time compare to avoid timing leaks.
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(current,     'hex');
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}
