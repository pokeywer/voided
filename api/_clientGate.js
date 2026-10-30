import { createHash } from 'node:crypto';

// Anything that ships as a HTTP library in Node, Python, Go, Java or a browser
// driver. No Roblox executor identifies itself with these, so refusing them is
// safe to enforce; a service that fetches loader links from a worker or a
// script hits one of these first.
const LIBRARY_TOKENS = [
    'undici', 'node-fetch', 'node.js', 'node/', 'axios', 'got/', 'request/', 'superagent',
    'python-requests', 'python-urllib', 'urllib3', 'aiohttp', 'httpx', 'urllib/',
    'okhttp', 'java/', 'go-http-client', 'curl/', 'wget/', 'libwww-perl', 'httpclient',
    'postmanruntime', 'postmancollectionrunner', 'insomnia', 'restsharp', 'faraday',
    'workerd', 'cloudflare-workers', 'cloudflare', 'vercel', 'edge-runtime', 'deno',
    'phantomjs', 'headlesschrome', 'headless', 'selenium', 'puppeteer', 'playwright',
    'httponlyhttpclient', 'nsurlsession', 'apifox', 'apipost-client', 'hoppscotch'
];

// Runtime names that only identify a script when they stand alone as a word, so
// a longer product name that happens to contain them cannot trip the guard.
const LIBRARY_WORDS = ['node', 'nodejs'];

// Command-line and library HTTP clients a person can script with. Several of
// them are also what a mobile executor's own HTTP backend sends, so they are
// only refused on the bootstrap link, where the real client is always the game
// calling HttpGet. The key and payload hops treat them as unknown traffic.
const PORTABLE_TOKENS = [
    'curl/', 'wget/', 'okhttp', 'java/', 'httpclient', 'nsurlsession', 'libwww-perl', 'faraday', 'apifox', 'apipost-client', 'hoppscotch'
];

// Names real clients send: the Roblox app itself and the executors players use.
const CLIENT_TOKENS = [
    'roblox', 'wininet', 'rblx', 'synapse', 'script-ware', 'scriptware', 'krnl', 'fluxus',
    'executor', 'electron', 'spore', 'wave', 'hydrogen', 'codex', 'swift', 'arceus',
    'volcano', 'potassium', 'phoenix', 'crocacuda', 'delta', 'prometheus', 'trigon',
    'macsploit', 'codewalker', 'orthus', 'auoowu', 'v1per', 'javis', 'bcore', 'nerve'
];

// Same wording the loader itself uses when it is running outside an executor,
// so a scripted caller gets the same answer from either side.
export const EXECUTOR_ONLY_MESSAGE = '[VoidedX] This loader only runs in an executor.';

export function clientGuardMode() {
    const value = String(process.env.LOADER_FETCH_GUARD || 'enforce').toLowerCase();
    return ['off', 'log', 'enforce'].includes(value) ? value : 'enforce';
}

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

// The user agent is spoofable in one line, so this is a cost and an
// attribution signal, not a wall. It is reported as a hash because the raw
// string is client-controlled noise that has no business in a log.
export function agentFingerprint(userAgent) {
    return createHash('sha256').update(`loader-agent\0${String(userAgent || '')}`).digest('hex').slice(0, 16);
}

export function inspectFetch(req, logTarget = '', endpoint = 'bootstrap') {
    const userAgent = req.headers && req.headers['user-agent'];
    const label = classifyAgent(userAgent, { toleratePortable: endpoint === 'gate' });
    const mode = clientGuardMode();
    const block = mode === 'enforce' && label === 'client-library';
    const fingerprint = agentFingerprint(userAgent);
    // A real client is a game or an executor and is not worth a log line; the
    // rest is either a script or a browser, and both are what the rule needs
    // measuring before it gets any tighter than "known HTTP libraries only".
    if (logTarget && mode !== 'off' && label !== 'client') {
        console.log(`loader-fetch:${label} ${fingerprint} ${logTarget}`);
    }
    return { label, mode, block, fingerprint };
}
