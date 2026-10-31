import { createHash, randomBytes } from 'node:crypto';
import * as loaderTokenModule from './_loaderToken.js';
import { buildRemovedVaultGui } from './_removedVaultGui.js';
import { obfuscateLoaderSource } from './_loaderObfuscator.js';
import { createConfusableFactory, buildStateMachineJunk, buildRegisterMachineJunk, armorVoidedxSource, OBFUSCATION_PROFILE_VERSION } from '../lua-voidedx-armor.js';

const { deriveBootstrapSeed, keyFingerprint } = loaderTokenModule;

// Namespace import on purpose: the API deploys as one catch-all function, so a
// single named export missing from a stale sibling file would stop every route
// from loading. Without the helper the loader just omits ?boot= and /api/verify
// answers with its own readable message instead of the whole site going dark.
const deliveryAttestation = typeof loaderTokenModule.deliveryAttestation === 'function'
    ? loaderTokenModule.deliveryAttestation
    : null;

export function loaderBootQuery(loaderToken, id) {
    if (!loaderToken || !deliveryAttestation) return '';
    // `dual` tells the gate this loader understands the two-secret delivery link
    // (code and hop) and the re-labelled payload reply. A loader built before it
    // asks for nothing, so it keeps being served the single-code link it parses.
    return `&boot=${encodeURIComponent(deliveryAttestation(loaderToken, id))}&dual=1`;
}

export function luaString(str) {
    const escaped = String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\0/g, '\\000');
    return `"${escaped}"`;
}

// Loader build stamp: the delivery bootstrap changes on its own schedule from
// the stored-copy profile, so both numbers are printed in the banner.
export const LOADER_BUILD = 10;

// The bootstrap is rebuilt for every /api/raw fetch and never stored with the
// vault, so weight that would push a saved copy past the Firestore document cap
// costs nothing here. Each layer wraps the whole loader in another VoidedX
// container, so a deobfuscator has to open all of them before it reaches the
// gate URL, the decoys or the delivery code.
const bootstrapLayerSetting = Number(process.env.BOOTSTRAP_ARMOR_LAYERS);
export const BOOTSTRAP_ARMOR_LAYERS = Number.isFinite(bootstrapLayerSetting)
    ? Math.max(0, Math.min(6, Math.round(bootstrapLayerSetting)))
    : 3;

function armorBootstrap(text) {
    if (!BOOTSTRAP_ARMOR_LAYERS) return text;
    const stamp = text.split('\n', 1)[0];
    const armored = armorVoidedxSource(text, {
        level: 'absolute',
        layers: BOOTSTRAP_ARMOR_LAYERS,
        junk: BOOTSTRAP_ARMOR_LAYERS >= 3 ? 'heavy' : 'normal',
        // Never stored, so the document caps that protect a saved vault do not
        // apply here; the ceiling is the executor's own HTTP response limit.
        nestLimit: 950 * 1024,
        totalLimit: 2600 * 1024
    });
    return `${stamp}\n${armored}`;
}

export const ROBLOX_ONLY_MESSAGE = '[VoidedX] This loader only works inside Roblox.';export const EXECUTOR_ONLY_MESSAGE = '[VoidedX] This loader only runs in an executor.';
export const FOREIGN_ORIGIN_MESSAGE = '[VoidedX] This loader only runs from its own link.';

// Hosts a loader is allowed to have been fetched from. A copy re-served by a
// paste site, a gist, a raw-file host or a script store names the URL it really
// came from, and that name is what the check below reads.
export function loaderOriginHosts(origin) {
    const hosts = new Set(['voidedx.vercel.app', 'localhost', '127.0.0.1']);
    try {
        hosts.add(new URL(String(origin)).host);
    } catch {
        // An unusable origin just means the built-in allowlist stands alone.
    }
    return [...hosts];
}

export function originGuardMode() {
    const value = String(process.env.LOADER_ORIGIN_GUARD || 'enforce').toLowerCase();
    return value === 'off' ? 'off' : 'enforce';
}

// Refuse a copy that reached the machine through somebody else's link. The chunk
// name is the executor's own record of where the string came from, so a loader
// served from a paste store reports that store, and the loader stops there. When
// the host gives no URL at all - which is what most executors name a pasted
// loadstring with - nothing is denied, because there is no evidence to deny on.
// One line: the minifier can glue a statement's `end` onto the next `if`.
export function foreignOriginGuard(origin) {
    if (originGuardMode() === 'off') return '';
    const list = loaderOriginHosts(origin).map(host => `"${host}"`).join(',');
    return `local vxOriginSource="" do local vxOriginOk,vxOriginInfo=pcall(function() return debug.getinfo(1,"S") end) if vxOriginOk and type(vxOriginInfo)=="table" and type(vxOriginInfo.source)=="string" then vxOriginSource=vxOriginInfo.source end end local vxOriginHost=string.match(vxOriginSource,"://([^/%?#]+)") if vxOriginHost then local vxOriginOwn=false for vxOriginIndex=1,#{${list}} do local vxAllowed=({${list}})[vxOriginIndex] if vxOriginHost==vxAllowed or string.sub(vxOriginHost,-#vxAllowed-1)=="."..vxAllowed then vxOriginOwn=true break end end if not vxOriginOwn then return error(${luaString(FOREIGN_ORIGIN_MESSAGE)},0) end end`;
}

// Every generated loader opens by proving it is running in a live Roblox client
// that was reached through an executor: `typeof` only exists in Luau, DataModel
// only exists in Roblox, and at least one injection-only primitive has to be
// present. A rehosted Lua, a bare Luau VM, or an analysis harness stubbed with
// plain tables is refused before the loader makes a single request.
export function executorOnlyGuard() {
    // Deny only when *none* of the drawn primitives exist, which is a bare
    // interpreter and nothing else. Three near-universal names stay in every draw
    // so no subset can strand an executor that simply lacks a niche function, and
    // the order plus the extra names move from build to build.
    const core = ['getgenv', 'request', 'http_request'];
    const extras = ['hookfunction', 'checkcaller', 'getrenv', 'setreadonly', 'writefile', 'readfile', 'isfile', 'listfiles', 'makefolder', 'gethui', 'queue_on_teleport', 'firetouchinterest'];
    const tables = ['syn', 'krnl', 'fluxus', 'proto', 'wave', 'universal', 'codex', 'hr', 'flame', 'nanos'];
    const chosen = core
        .concat(bootShuffle(extras).slice(0, randomBytes(1)[0] % 4))
        .concat(bootShuffle(tables).slice(0, randomBytes(1)[0] % 2));
    const parts = bootShuffle(chosen)
        .map(name => `type(${name})~="${tables.includes(name) ? 'table' : 'function'}"`);
    return `if ${parts.join(' and ')} then return error(${luaString(EXECUTOR_ONLY_MESSAGE)},0) end`;
}

// The engine check asked for the same three services and one instance in every
// build. Draw a different set each time: any real DataModel answers all of them,
// and a stubbed `game` table that only fakes Players/Workspace no longer passes.
export function robloxProbeChecks() {
    const services = [
        ['Players', 'Players'], ['Workspace', 'Workspace'], ['Lighting', 'Lighting'],
        ['ReplicatedStorage', 'ReplicatedStorage'], ['SoundService', 'SoundService'],
        ['RunService', 'RunService'], ['StarterGui', 'StarterGui'],
        ['UserInputService', 'UserInputService'], ['TweenService', 'TweenService'],
        ['ContextActionService', 'ContextActionService'], ['GuiService', 'GuiService'],
        ['AudioService', 'AudioService']
    ];
    const instances = ['Folder', 'Sound', 'RemoteEvent', 'BindableFunction', 'RemoteFunction', 'BindableEvent'];
    return {
        services: bootShuffle(services).slice(0, 3 + (randomBytes(1)[0] % 3)),
        instance: bootPick(instances)
    };
}

export function robloxOnlyGuard(origin = 'https://voidedx.vercel.app') {
    // First the engine: a real Roblox DataModel. Then the injection layer: at
    // least one primitive that only exists once a script has been run through an
    // executor. Roblox itself, the Studio command bar and a bare Luau host have
    // the first and not the second, so the loader stops there instead of handing
    // its gate, its token and its payload to an environment that is not playing
    // the game. One line: the minifier can glue a statement's `end` onto the
    // next `if` and Luau reads that as `endif`.
    return `if type(typeof)~="function" or typeof(game)~="Instance" or game.ClassName~="DataModel" then return error(${luaString(ROBLOX_ONLY_MESSAGE)},0) end ${executorOnlyGuard()} ${foreignOriginGuard(origin)}`;
}

// Return a compact transport copy; this is cosmetic and does not replace the
// server-side ticket and key checks that protect delivery.
export function compactGeneratedLoader(source) {
    let output = '';
    let index = 0;
    let needsSpace = false;

    const append = value => {
        if (needsSpace && output && !output.endsWith(' ')) output += ' ';
        output += value;
        needsSpace = false;
    };
    const longBracket = start => {
        if (source[start] !== '[') return null;
        let cursor = start + 1;
        while (source[cursor] === '=') cursor++;
        if (source[cursor] !== '[') return null;
        return { contentStart: cursor + 1, close: `]${'='.repeat(cursor - start - 1)}]` };
    };

    while (index < source.length) {
        const char = source[index];
        if (/\s/.test(char)) {
            needsSpace = true;
            index++;
            continue;
        }

        if (char === '-' && source[index + 1] === '-') {
            needsSpace = true;
            const bracket = longBracket(index + 2);
            if (bracket) {
                const closeIndex = source.indexOf(bracket.close, bracket.contentStart);
                index = closeIndex < 0 ? source.length : closeIndex + bracket.close.length;
            } else {
                while (index < source.length && source[index] !== '\n') index++;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            const quote = char;
            let end = index + 1;
            while (end < source.length) {
                if (source[end] === '\\') { end += 2; continue; }
                if (source[end++] === quote) break;
            }
            append(source.slice(index, end));
            index = end;
            continue;
        }

        const bracket = longBracket(index);
        if (bracket) {
            const closeIndex = source.indexOf(bracket.close, bracket.contentStart);
            const end = closeIndex < 0 ? source.length : closeIndex + bracket.close.length;
            append(source.slice(index, end));
            index = end;
            continue;
        }

        append(char);
        index++;
    }

    return output.trim();
}

// Shared with the obfuscation banner so every VoidedX surface uses the same
// block lettering.
const LOADER_BANNER_FONT = {
    V: ['##   ##', '##   ##', '##   ##', ' ## ## ', '  ###  '],
    O: [' ##### ', '##   ##', '##   ##', '##   ##', ' ##### '],
    I: ['######', '  ##  ', '  ##  ', '  ##  ', '######'],
    D: ['##### ', '##  ##', '##  ##', '##  ##', '##### '],
    E: ['######', '##    ', '####  ', '##    ', '######'],
    X: ['##   ##', ' ## ## ', '  ###  ', ' ## ## ', '##   ##']
};

function buildLoaderBanner() {
    const rows = ['', '', '', '', ''];
    for (const letter of 'VOIDEDX') {
        const glyph = LOADER_BANNER_FONT[letter] || ['      ', '      ', '      ', '      ', '      '];
        for (let row = 0; row < 5; row += 1) rows[row] += glyph[row] + ' ';
    }
    return [
        `--voidedx-loader-p${OBFUSCATION_PROFILE_VERSION}-b${LOADER_BUILD}`,
        '--[[',
        '   ' + rows[0],
        '   ' + rows[1],
        '   ' + rows[2],
        '   ' + rows[3],
        '   ' + rows[4],
        '',
        `   VOIDEDX LOADER   //   voidedx.vercel.app   //   profile ${OBFUSCATION_PROFILE_VERSION}   build ${LOADER_BUILD}`,
        '   protected delivery build   |   do not resell',
        ']]'
    ].join('\n');
}

const LOADER_NAME_SYLLABLES = [
    'ka', 'zu', 'mo', 're', 'ti', 'vo', 'ne', 'ra', 'sh', 'ul',
    'ix', 'om', 'ep', 'an', 'yi', 'qu', 'da', 'po', 'fi', 'xe'
];

// A fixed `_0x` prefix is itself a fingerprint, so the naming scheme is drawn
// per build: hex, syllable pairs, or random base36. The counter keeps every
// name unique and the leading underscore keeps them clear of globals.
function createLoaderNames() {
    const used = new Set();
    const draw = () => randomBytes(1)[0];
    const style = draw() % 3;
    let prefix;
    if (style === 0) {
        prefix = `_0x${randomBytes(3).toString('hex')}`;
    } else if (style === 1) {
        prefix = `_${LOADER_NAME_SYLLABLES[draw() % LOADER_NAME_SYLLABLES.length]}`
            + `${LOADER_NAME_SYLLABLES[draw() % LOADER_NAME_SYLLABLES.length]}`;
    } else {
        prefix = `_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/g, 'z')}`;
    }
    let counter = 0;
    return () => {
        let name;
        do {
            counter += 1;
            name = `${prefix}${counter.toString(36)}`;
        } while (used.has(name));
        used.add(name);
        return name;
    };
}

// The returned bootstrap carries only ciphertext: the inner loader is sealed
// with the token-derived seed, and the gate URL (which embeds the live token)
// is sealed with a per-build key. It opens with a VoidedX banner and refuses to
// decrypt when the runtime has been instrumented, so a dumped body cannot be
// read or replayed with a hooked loadstring/HttpGet. The gate response releases
// the seed, so a captured body alone still cannot be decrypted offline.
// Fabricated loader tokens carry the same structure as issued ones (base64url
// JSON + base64url HMAC), so a captured request log cannot separate a decoy
// from a revoked credential. Their signature is random, so the gate answers
// 410 before it ever touches Firestore.
const FAKE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomTokenString(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += FAKE_TOKEN_ALPHABET[bytes[index] % FAKE_TOKEN_ALPHABET.length];
    }
    return out;
}

function fakeLoaderToken(keyMaterial) {
    const payload = {
        version: 2,
        vaultId: randomTokenString(20),
        keyHash: keyMaterial ? createHash('sha256').update(String(keyMaterial)).digest('hex') : '',
        vaultVersion: 0,
        expiresAt: Date.now() + 10_000,
        nonce: randomBytes(16).toString('base64url'),
        binding: randomBytes(16).toString('hex')
    };
    return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

const BOOT_B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Each codec is a different xorshift shape and byte schedule. The Lua side is
// emitted with the same constants, so every fetch can pick a different decoder
// without the two ever drifting apart. Every codec carries four shifts so the
// emitted decoder can consume a whole 32-bit word per keystream step.
const BOOT_CODECS = Object.freeze([
    { a: 13, b: 17, c: 5, shifts: [24, 16, 8, 0] },
    { a: 7, b: 9, c: 13, shifts: [16, 24, 0, 8] },
    { a: 5, b: 11, c: 29, shifts: [24, 0, 16, 8] }
]);

function bootPick(list) {
    return list[randomBytes(1)[0] % list.length];
}

function bootShuffle(items) {
    const out = items.slice();
    for (let index = out.length - 1; index > 0; index -= 1) {
        const swapIndex = randomBytes(1)[0] % (index + 1);
        const value = out[index];
        out[index] = out[swapIndex];
        out[swapIndex] = value;
    }
    return out;
}

function bootCodec() {
    return bootPick(BOOT_CODECS);
}

function bootAlphabet() {
    return bootShuffle(BOOT_B64_STD.split('')).join('');
}

function bootNextState(state, codec) {
    let value = state >>> 0;
    value = (value ^ (value << codec.a)) >>> 0;
    value = (value ^ (value >>> codec.b)) >>> 0;
    value = (value ^ (value << codec.c)) >>> 0;
    return value >>> 0;
}

function bootChainSum(buffer, hash) {
    return bootDigest(buffer, hash);
}

function bootFallbackKey() {
    return (randomBytes(4).readUInt32BE(0) | 1) >>> 0;
}

function bootXor(input, seed, codec, fallback) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
    const output = Buffer.allocUnsafe(buffer.length);
    const width = codec.shifts.length;
    let state = (Number(seed) >>> 0) || (fallback || 0x9E3779B9);
    for (let index = 0; index < buffer.length; index += 1) {
        if (index % width === 0) state = bootNextState(state, codec);
        output[index] = buffer[index] ^ ((state >>> codec.shifts[index % width]) & 0xFF);
    }
    return output;
}

function encodeBootAlphabet(buffer, alphabet) {
    const encoded = buffer.toString('base64');
    let out = '';
    for (const char of encoded) {
        const index = BOOT_B64_STD.indexOf(char);
        out += index === -1 ? char : alphabet[index];
    }
    return out;
}

function bootSbox() {
    const perm = [];
    for (let index = 0; index < 256; index += 1) perm.push(index);
    for (let index = 255; index > 0; index -= 1) {
        const swap = randomBytes(1)[0] % (index + 1);
        const value = perm[index];
        perm[index] = perm[swap];
        perm[swap] = value;
    }
    return Buffer.from(perm);
}

// A checksum shape, shared by both sides. The JS encoder needs it to compute the
// value it embeds and the emitted Lua needs it to recompute the same one, so the
// descriptor is drawn once per build and passed to both. Multiplier, modulus,
// start value and scan direction all move, which is what stops the digest helper
// from being one recognizable line in every copy.
function bootHash() {
    const mods = [4294967296, 4294967291, 2147483647];
    const mod = bootPick(mods);
    let mult = (randomBytes(2).readUInt16BE(0) | 1) % 900 + 131;
    if (mult >= mod) mult = mod - 1;
    return {
        mult,
        mod,
        init: (randomBytes(4).readUInt32BE(0) % (mod - 1)) || 1,
        reverse: (randomBytes(1)[0] & 1) === 1
    };
}

function bootDigest(buffer, hash) {
    let value = hash.init;
    const step = hash.reverse ? -1 : 1;
    const from = hash.reverse ? buffer.length - 1 : 0;
    for (let index = from; index >= 0 && index < buffer.length; index += step) {
        value = (value * hash.mult + buffer[index]) % hash.mod;
    }
    return value;
}

// Lua source for the same digest, in either scan direction.
function bootHashLines(fn, val, hsh, idx, hash) {
    const loop = hash.reverse ? `for ${idx}=#${val},1,-1 do` : `for ${idx}=1,#${val} do`;
    return [
        `local ${fn}=function(${val})`,
        `local ${hsh}=${hash.init}`,
        loop,
        `${hsh}=(${hsh}*${hash.mult}+string.byte(${val},${idx}))%${hash.mod}`,
        `end`,
        `return ${hsh}`,
        `end`
    ];
}

// The sealed body used to be unpacked by one fixed block of statements, so
// erasing the random names left the same decoder in every copy. These shapes all
// read the same base64 string but are written differently: a four-wide window
// with shift constants, a stride loop that folds each group digit by digit, and a
// flat scanner that never looks at a group boundary at all.
const BOOT_PIPE_SHAPES = Object.freeze(['window', 'stride', 'scan']);
// The keystream had one shape too: either four bytes land per step from one word,
// or a mask table is refreshed on the word boundary and consumed one byte at a
// time. Same stream, different statements.
const BOOT_MASK_SHAPES = Object.freeze(['grouped', 'stream']);

function bootFlushSize() {
    return bootPick([512, 768, 1024, 1536, 2048, 3072, 4096]);
}

// The 32-bit word size has to stay 32 bits, but it does not have to be written
// the same way twice. Always parenthesized: `s%0xFFFFFFFF+1` would fold as
// `(s%0xFFFFFFFF)+1` and quietly change the keystream.
function bootWord32() {
    return bootPick(['(4294967296)', '(2147483648*2)', '(1073741824*4)', '(536870912*8)', '(0xFFFFFFFF+1)']);
}


export function packGeneratedLoader(source, { id, key = '', origin, token }) {
    const innerBanner = '-- VoidedX Loader [https://voidedx.vercel.app]';
    const seed = deriveBootstrapSeed(token);
    const sealed = obfuscateLoaderSource(source);
    // The marks bracket the sealed body: the head proves the seed, the tail
    // proves the body was not truncated.
    const bootMark = `--[[vb:${randomBytes(6).toString('hex')}]]`;
    const tailMark = `--[[vt:${randomBytes(6).toString('hex')}]]`;
    const codec = bootCodec();
    const alphabet = bootAlphabet();
    const sbox = bootSbox();
    // Drawn once per build and handed to both sides: the JS encoder produces the
    // literals and the checksum, the emitted Lua reproduces them.
    const hash = bootHash();
    const fallbackKey = bootFallbackKey();
    // LOADER_PIPE_SHAPE / LOADER_MASK_SHAPE exist so a test run can force one
    // shape and prove every variant executes, instead of waiting for the draw to
    // pick it. Unset, both are per-build randomness like everything else.
    const pipeSetting = String(process.env.LOADER_PIPE_SHAPE || '').toLowerCase();
    const pipe = BOOT_PIPE_SHAPES.includes(pipeSetting) ? pipeSetting : bootPick(BOOT_PIPE_SHAPES);
    const maskSetting = String(process.env.LOADER_MASK_SHAPE || '').toLowerCase();
    const maskShape = BOOT_MASK_SHAPES.includes(maskSetting) ? maskSetting : bootPick(BOOT_MASK_SHAPES);
    const word32 = bootWord32();
    const flush = bootFlushSize();
    const sealBlob = (buffer, blobKey) => {
        const mixed = bootXor(buffer, blobKey, codec, fallbackKey);
        const substituted = Buffer.allocUnsafe(mixed.length);
        for (let index = 0; index < mixed.length; index += 1) substituted[index] = sbox[mixed[index]];
        return encodeBootAlphabet(substituted, alphabet);
    };
    // Part keys chain: each key mixes the previous decoded part, so the pieces
    // only open in order and a single captured part decrypts to noise.
    const partCount = 1 + (randomBytes(1)[0] % 3);
    const partStep = randomBytes(4).readUInt32BE(0) || 0x9E3779B9;
    const chainSeed = randomBytes(4).readUInt32BE(0) || 0x85EBCA6B;
    const codeBytes = Buffer.from(`${bootMark}\n${innerBanner}\n${sealed}\n${tailMark}`, 'utf8');
    const partSize = Math.ceil(codeBytes.length / partCount) || 1;
    const dataParts = [];
    let chain = chainSeed;
    for (let part = 0; part < partCount; part += 1) {
        const slice = codeBytes.subarray(part * partSize, Math.min((part + 1) * partSize, codeBytes.length));
        const partKey = (((seed + part * partStep) % 4294967296) ^ chain) >>> 0;
        dataParts.push(sealBlob(slice, partKey));
        chain = bootChainSum(slice, hash);
    }
    const dataLiteral = dataParts.map(part => `"${part}"`).join(',');

    const gateDay = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    // Decoys carry a real-looking day within a month of today, so the parameter
    // does not single out the live entry in a request log.
    const nearbyDay = () => new Date(Date.now() + (randomBytes(1)[0] - 128) * 86_400_000)
        .toISOString().slice(0, 10).replaceAll('-', '');
    const buildGateUrl = ({ vaultId, token: gateToken, key: gateKey, hint }) => {
        const usedKey = gateKey ?? key;
        // Credential, key hint, mint day and nonce all sit beside the vault id,
        // and decoys are built the same way from their own key and a plausible
        // nearby date, so a request log cannot mark the live entry.
        const url = new URL('/api/raw', origin);
        url.searchParams.set('id', vaultId);
        url.searchParams.set('token', gateToken);
        url.searchParams.set('format', 'token-check');
        if (usedKey) {
            url.searchParams.set('key', usedKey);
            url.searchParams.set('kh', keyFingerprint(usedKey).slice(0, 8));
        }
        url.searchParams.set('d', hint || gateDay);
        url.searchParams.set('n', randomBytes(9).toString('hex'));
        return url.href;
    };

    // Each URL is sealed in two halves under two different keys, cut inside the
    // token itself, so no single decoded blob ever holds the whole credential.
    const sealUrl = href => {
        const firstKey = randomBytes(4).readUInt32BE(0) || 1;
        const secondKey = randomBytes(4).readUInt32BE(0) || 1;
        const start = href.indexOf('token=');
        let cut = Math.floor(href.length / 2);
        if (start !== -1) {
            const valueStart = start + 'token='.length;
            const valueEnd = href.indexOf('&', valueStart) === -1 ? href.length : href.indexOf('&', valueStart);
            if (valueEnd - valueStart > 8) cut = valueStart + 1 + (randomBytes(1)[0] % (valueEnd - valueStart - 2));
        }
        return {
            c1: sealBlob(Buffer.from(href.slice(0, cut), 'utf8'), firstKey),
            k1: firstKey,
            c2: sealBlob(Buffer.from(href.slice(cut), 'utf8'), secondKey),
            k2: secondKey
        };
    };

    const decoyKey = randomBytes(32).toString('hex');
    const realUrl = sealUrl(buildGateUrl({ vaultId: id, token, key }));
    const decoyCount = 2 + (randomBytes(1)[0] % 3);
    const decoys = [];
    for (let index = 0; index < decoyCount; index += 1) {
        if (index === 0) {
            decoys.push(sealUrl(buildGateUrl({
                vaultId: randomTokenString(20),
                token: fakeLoaderToken(key ? decoyKey : ''),
                key: key ? decoyKey : '',
                hint: nearbyDay()
            })));
        } else {
            decoys.push(sealUrl(buildGateUrl({ vaultId: id, token: fakeLoaderToken(key), key, hint: nearbyDay() })));
        }
    }
    const gateList = bootShuffle([realUrl].concat(decoys));
    const gateTable = gateList
        .map(entry => `{"${entry.c1}",0x${entry.k1.toString(16)},"${entry.c2}",0x${entry.k2.toString(16)}}`)
        .join(',');
    const probeOrder = bootShuffle(gateList.map((entry, index) => index + 1)).join(',');
    const chunkName = randomBytes(6).toString('hex');
    const sessionId = randomBytes(8).toString('hex');
    const fileTag = createHash('sha256').update(`${id} ${key} ${token}`).digest('hex').slice(0, 10);
    const sboxLiteral = encodeBootAlphabet(sbox, alphabet);

    const nx = createLoaderNames();
    const loc = (...roles) => {
        const out = {};
        for (const role of roles) out[role] = nx();
        return out;
    };
    const n = {
        rbx: nx(), map: nx(), alpha: nx(), b64: nx(), isb: nx(), dec: nx(), sum: nx(),
        cap: nx(), guard: nx(), lstr: nx(), ld: nx(), gv: nx(), gf: nx(), dmp: nx(),
        state: nx(), handlerTable: nx(), probeOne: nx(), seq: nx(), main: nx()
    };
    const S = n.state;

    const capEntries = [
        ['byte', 'string.byte'], ['char', 'string.char'], ['sub', 'string.sub'],
        ['gsub', 'string.gsub'], ['match', 'string.match'], ['concat', 'table.concat'],
        ['pcall', 'pcall'], ['error', 'error'], ['type', 'type'], ['floor', 'math.floor'],
        ['load', 'loadstring or load'], ['http', 'game.HttpGet'],
        ['httpStable', 'game.HttpGet==game.HttpGet'],
        ['loadStable', '(loadstring or load)==(loadstring or load)'],
        ['getgenv', 'type(getgenv)=="function" and getgenv or nil'],
        ['getfenv', 'type(getfenv)=="function" and getfenv or nil'],
        ['setfenv', 'type(setfenv)=="function" and setfenv or nil'],
        ['gethook', 'type(debug)=="table" and debug.gethook or nil'],
        ['bit32', 'type(bit32)=="table" and bit32 or nil'],
        ['tostring', 'type(tostring)=="function" and tostring or nil'],
        ['tonumber', 'type(tonumber)=="function" and tonumber or nil'],
        ['sethook', 'type(debug)=="table" and debug.sethook or nil'],
        ['writefile', 'type(writefile)=="function" and writefile or nil'],
        ['readfile', 'type(readfile)=="function" and readfile or nil'],
        ['isfile', 'type(isfile)=="function" and isfile or nil']
    ];
    const capSlots = bootShuffle(Array.from({ length: 64 }, (_, index) => index + 1)).slice(0, capEntries.length);
    const capSlot = {};
    capEntries.forEach((entry, index) => { capSlot[entry[0]] = capSlots[index]; });
    const cap = name => `${n.cap}[${capSlot[name]}]`;

    const slotPool = bootShuffle(Array.from({ length: 72 }, (_, index) => index + 1));
    const sl = {};
    for (const role of [
        'data', 'sealed', 'order', 'decoded', 'seed', 'fails', 'rejected', 'done', 'deny', 'expired',
        'net', 'mark', 'tail', 'step', 'chain', 'spawn', 'wait', 'loader', 'code', 'arg',
        'chunk', 'wd', 'off', 'env', 'session', 'beacon'
    ]) {
        sl[role] = slotPool.pop();
    }
    const st = role => `${S}[${sl[role]}]`;

    const lines = [];
    const add = line => lines.push(line);

    add(buildLoaderBanner());

    const R = loc('ok', 'svc');
    const probe = robloxProbeChecks();
    add(`local ${n.rbx}=function()`);
    add(`if type(typeof)~="function" or typeof(game)~="Instance" or game.ClassName~="DataModel" then return false end`);
    probe.services.forEach((entry, index) => {
        add(`${index === 0 ? 'local ' : ''}${R.ok},${R.svc}=pcall(function() return game:GetService("${entry[0]}") end)`);
        add(`if not ${R.ok} or typeof(${R.svc})~="Instance" or ${R.svc}.ClassName~="${entry[1]}" then return false end`);
    });
    add(`${R.ok},${R.svc}=pcall(function() return Instance.new("${probe.instance}") end)`);
    add(`if not ${R.ok} or typeof(${R.svc})~="Instance" or ${R.svc}.ClassName~="${probe.instance}" then return false end`);
    add(`pcall(function() ${R.svc}:Destroy() end)`);
    add(`return true`);
    add(`end`);
    add(`if not ${n.rbx}() then return error(${luaString(ROBLOX_ONLY_MESSAGE)},0) end`);
    add(executorOnlyGuard());
    add(foreignOriginGuard(origin));

    const A = loc('alpha', 'i');
    add(`local ${n.map}={}`);
    add(`do local ${A.alpha}="${alphabet}"`);
    add(`for ${A.i}=1,#${A.alpha} do ${n.map}[string.byte(${A.alpha},${A.i})]=${A.i}-1 end end`);

    const B = loc('v', 'r', 'n', 'o', 't', 'k', 'tk', 'i', 'j', 'c', 'q', 'g', 'p', 'h3', 'h4', 'c1', 'c2', 'c3', 'c4', 'q1', 'q2', 'q3', 'q4', 'x', 'b1', 'b2', 'b3');
    // One sealed string, three readings. The shape is drawn per build, so the
    // decode block is not one fixed pattern an unpacker can match on: a four-wide
    // window with digit weights, a stride loop that folds each group, and a flat
    // scanner that never looks at a group boundary at all.
    if (pipe === 'stride') {
        add(`local ${n.b64}=function(${B.v})`);
        add(`local ${B.r}=#${B.v}%4`);
        add(`if ${B.r}==2 then ${B.v}=${B.v}.."==" elseif ${B.r}==3 then ${B.v}=${B.v}.."=" end`);
        add(`local ${B.o}={} local ${B.t}={}`);
        add(`local ${B.k},${B.tk}=0,0`);
        add(`local ${B.i}=1`);
        add(`while ${B.i}<=#${B.v} do`);
        add(`local ${B.x}=0`);
        add(`for ${B.j}=${B.i},${B.i}+3 do`);
        add(`local ${B.c}=string.byte(${B.v},${B.j})`);
        add(`${B.x}=${B.x}*64+((${B.c} and ${n.map}[${B.c}]) or 0)`);
        add(`end`);
        add(`local ${B.h3}=string.byte(${B.v},${B.i}+2) local ${B.h4}=string.byte(${B.v},${B.i}+3)`);
        add(`${B.h3}=${B.h3} and ${n.map}[${B.h3}] ${B.h4}=${B.h4} and ${n.map}[${B.h4}]`);
        add(`local ${B.b1}=math.floor(${B.x}/65536) local ${B.b2}=math.floor(${B.x}/256)%256`);
        add(`local ${B.b3}=${B.x}%256`);
        add(`if ${B.h4} then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2},${B.b3})`);
        add(`elseif ${B.h3} then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2})`);
        add(`else ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1}) end`);
        add(`if ${B.tk}>=${flush} then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) ${B.t}={} ${B.tk}=0 end`);
        add(`${B.i}=${B.i}+4`);
        add(`end`);
        add(`if ${B.tk}>0 then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) end`);
        add(`return table.concat(${B.o})`);
        add(`end`);
    } else if (pipe === 'scan') {
        add(`local ${n.b64}=function(${B.v})`);
        add(`local ${B.r}=#${B.v}%4`);
        add(`if ${B.r}==2 then ${B.v}=${B.v}.."==" elseif ${B.r}==3 then ${B.v}=${B.v}.."=" end`);
        add(`local ${B.o},${B.t}={}, {}`);
        add(`local ${B.k},${B.tk}=0,0`);
        add(`local ${B.x},${B.g},${B.p}=0,0,0`);
        add(`for ${B.i}=1,#${B.v} do`);
        add(`local ${B.q}=${n.map}[string.byte(${B.v},${B.i})]`);
        add(`${B.x}=${B.x}*64+(${B.q} or 0) ${B.g}=${B.g}+1`);
        add(`if ${B.q}==nil then ${B.p}=${B.p}+1 end`);
        add(`if ${B.g}==4 then`);
        add(`local ${B.b1}=math.floor(${B.x}/65536) local ${B.b2}=math.floor(${B.x}/256)%256`);
        add(`local ${B.b3}=${B.x}%256`);
        add(`if ${B.p}==0 then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2},${B.b3})`);
        add(`elseif ${B.p}==1 then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2})`);
        add(`else ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1}) end`);
        add(`${B.x}=0 ${B.g}=0 ${B.p}=0`);
        add(`if ${B.tk}>=${flush} then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) ${B.t}={} ${B.tk}=0 end`);
        add(`end`);
        add(`end`);
        add(`if ${B.tk}>0 then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) end`);
        add(`return table.concat(${B.o})`);
        add(`end`);
    } else {
        add(`local ${n.b64}=function(${B.v})`);
        add(`local ${B.r}=#${B.v}%4`);
        add(`if ${B.r}==2 then ${B.v}=${B.v}.."==" elseif ${B.r}==3 then ${B.v}=${B.v}.."=" end`);
        add(`local ${B.n}=#${B.v}`);
        add(`local ${B.o}={}`);
        add(`local ${B.t}={}`);
        add(`local ${B.k},${B.tk}=0,0`);
        add(`local ${B.i}=1`);
        add(`while ${B.i}<=${B.n} do`);
        add(`local ${B.c1},${B.c2},${B.c3},${B.c4}=string.byte(${B.v},${B.i},${B.i}+3)`);
        add(`local ${B.q1},${B.q2}=${n.map}[${B.c1}],${n.map}[${B.c2}]`);
        add(`local ${B.q3},${B.q4}=${n.map}[${B.c3}],${n.map}[${B.c4}]`);
        add(`local ${B.x}=(${B.q1} or 0)*262144+(${B.q2} or 0)*4096+(${B.q3} or 0)*64+(${B.q4} or 0)`);
        add(`local ${B.b1}=bit32.rshift(${B.x},16)`);
        add(`local ${B.b2}=bit32.band(bit32.rshift(${B.x},8),255)`);
        add(`local ${B.b3}=bit32.band(${B.x},255)`);
        add(`if ${B.q4} then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2},${B.b3})`);
        add(`elseif ${B.q3} then ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1},${B.b2})`);
        add(`else ${B.tk}=${B.tk}+1 ${B.t}[${B.tk}]=string.char(${B.b1}) end`);
        add(`if ${B.tk}>=${flush} then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) ${B.t}={} ${B.tk}=0 end`);
        add(`${B.i}=${B.i}+4`);
        add(`end`);
        add(`if ${B.tk}>0 then ${B.k}=${B.k}+1 ${B.o}[${B.k}]=table.concat(${B.t}) end`);
        add(`return table.concat(${B.o})`);
        add(`end`);
    }

    const I = loc('t', 'i');
    add(`local ${n.isb}={}`);
    add(`do local ${I.t}=${n.b64}("${sboxLiteral}")`);
    add(`for ${I.i}=1,#${I.t} do ${n.isb}[string.byte(${I.t},${I.i})]=${I.i}-1 end end`);

    const D = loc('v', 's', 'n', 'o', 't', 'k', 'tk', 'i', 'm1', 'm2', 'm3', 'm4', 'b1', 'b2', 'b3', 'b4', 'mask');
    // Same keystream, two readings: the grouped form consumes a whole 32-bit word
    // per step, the stream form refreshes a four-entry mask table on the word
    // boundary and eats one byte at a time.
    if (maskShape === 'stream') {
        add(`local ${n.dec}=function(${D.v},${D.s})`);
        add(`${D.v}=${n.b64}(${D.v})`);
        add(`local ${D.n}=#${D.v}`);
        add(`local ${D.o}={} local ${D.t}={}`);
        add(`local ${D.k},${D.tk}=0,0`);
        add(`${D.s}=${D.s}%${word32}`);
        add(`if ${D.s}==0 then ${D.s}=${fallbackKey} end`);
        add(`local ${D.mask}={0,0,0,0}`);
        add(`for ${D.i}=1,${D.n} do`);
        add(`if (${D.i}-1)%4==0 then`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.lshift(${D.s},${codec.a}))`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.rshift(${D.s},${codec.b}))`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.lshift(${D.s},${codec.c}))`);
        add(`${D.mask}[1]=bit32.band(bit32.rshift(${D.s},${codec.shifts[0]}),255)`);
        add(`${D.mask}[2]=bit32.band(bit32.rshift(${D.s},${codec.shifts[1]}),255)`);
        add(`${D.mask}[3]=bit32.band(bit32.rshift(${D.s},${codec.shifts[2]}),255)`);
        add(`${D.mask}[4]=bit32.band(bit32.rshift(${D.s},${codec.shifts[3]}),255)`);
        add(`end`);
        add(`${D.tk}=${D.tk}+1`);
        add(`${D.t}[${D.tk}]=string.char(bit32.bxor(${n.isb}[string.byte(${D.v},${D.i})],${D.mask}[(${D.i}-1)%4+1]))`);
        add(`if ${D.tk}>=${flush} then ${D.k}=${D.k}+1 ${D.o}[${D.k}]=table.concat(${D.t}) ${D.t}={} ${D.tk}=0 end`);
        add(`end`);
        add(`if ${D.tk}>0 then ${D.k}=${D.k}+1 ${D.o}[${D.k}]=table.concat(${D.t}) end`);
        add(`return table.concat(${D.o})`);
        add(`end`);
    } else {
        add(`local ${n.dec}=function(${D.v},${D.s})`);
        add(`${D.v}=${n.b64}(${D.v})`);
        add(`local ${D.n}=#${D.v}`);
        add(`local ${D.o}={}`);
        add(`local ${D.t}={}`);
        add(`local ${D.k},${D.tk}=0,0`);
        add(`${D.s}=${D.s}%${word32}`);
        add(`if ${D.s}==0 then ${D.s}=${fallbackKey} end`);
        add(`local ${D.i}=1`);
        add(`while ${D.i}<=${D.n} do`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.lshift(${D.s},${codec.a}))`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.rshift(${D.s},${codec.b}))`);
        add(`${D.s}=bit32.bxor(${D.s},bit32.lshift(${D.s},${codec.c}))`);
        add(`local ${D.m1}=bit32.band(bit32.rshift(${D.s},${codec.shifts[0]}),255)`);
        add(`local ${D.m2}=bit32.band(bit32.rshift(${D.s},${codec.shifts[1]}),255)`);
        add(`local ${D.m3}=bit32.band(bit32.rshift(${D.s},${codec.shifts[2]}),255)`);
        add(`local ${D.m4}=bit32.band(bit32.rshift(${D.s},${codec.shifts[3]}),255)`);
        add(`local ${D.b1},${D.b2},${D.b3},${D.b4}=string.byte(${D.v},${D.i},${D.i}+3)`);
        add(`if ${D.b4} then ${D.tk}=${D.tk}+1 ${D.t}[${D.tk}]=string.char(bit32.bxor(${n.isb}[${D.b1}],${D.m1}),bit32.bxor(${n.isb}[${D.b2}],${D.m2}),bit32.bxor(${n.isb}[${D.b3}],${D.m3}),bit32.bxor(${n.isb}[${D.b4}],${D.m4}))`);
        add(`elseif ${D.b3} then ${D.tk}=${D.tk}+1 ${D.t}[${D.tk}]=string.char(bit32.bxor(${n.isb}[${D.b1}],${D.m1}),bit32.bxor(${n.isb}[${D.b2}],${D.m2}),bit32.bxor(${n.isb}[${D.b3}],${D.m3}))`);
        add(`elseif ${D.b2} then ${D.tk}=${D.tk}+1 ${D.t}[${D.tk}]=string.char(bit32.bxor(${n.isb}[${D.b1}],${D.m1}),bit32.bxor(${n.isb}[${D.b2}],${D.m2}))`);
        add(`else ${D.tk}=${D.tk}+1 ${D.t}[${D.tk}]=string.char(bit32.bxor(${n.isb}[${D.b1}],${D.m1})) end`);
        add(`if ${D.tk}>=${flush} then ${D.k}=${D.k}+1 ${D.o}[${D.k}]=table.concat(${D.t}) ${D.t}={} ${D.tk}=0 end`);
        add(`${D.i}=${D.i}+4`);
        add(`end`);
        add(`if ${D.tk}>0 then ${D.k}=${D.k}+1 ${D.o}[${D.k}]=table.concat(${D.t}) end`);
        add(`return table.concat(${D.o})`);
        add(`end`);
    }

    for (const line of bootHashLines(n.sum, ...Object.values(loc('v', 'h', 'i')), hash)) add(line);

    add(`local ${n.cap}={}`);
    add(`do`);
    for (const entry of bootShuffle(capEntries.slice())) {
        add(`${n.cap}[${capSlot[entry[0]]}]=${entry[1]}`);
    }
    add(`end`);

    add(`local ${n.lstr}=loadstring`);
    add(`local ${n.ld}=load`);
    add(`local ${n.gv}=type(getgenv)=="function" and getgenv or nil`);
    add(`local ${n.gf}=type(getfenv)=="function" and getfenv or nil`);
    add(`local ${n.dmp}=type(string.dump)=="function" and string.dump or nil`);

    const G = loc('own', 'envs', 'add');
    const DP = loc('calib');
    add(`local ${n.guard}=function(${G.own})`);
    add(`if ${cap('loadStable')} and (loadstring or load)~=${cap('load')} then return false end`);
    add(`if ${cap('httpStable')} and game.HttpGet~=${cap('http')} then return false end`);
    add(`if string.byte~=${cap('byte')} or string.char~=${cap('char')} or string.sub~=${cap('sub')} or string.gsub~=${cap('gsub')} or string.match~=${cap('match')} then return false end`);
    add(`if table.concat~=${cap('concat')} or pcall~=${cap('pcall')} or error~=${cap('error')} or type~=${cap('type')} or math.floor~=${cap('floor')} then return false end`);
    add(`if ${cap('getgenv')} and (type(getgenv)~="function" or getgenv~=${cap('getgenv')}) then return false end`);
    add(`if ${cap('getfenv')} and (type(getfenv)~="function" or getfenv~=${cap('getfenv')}) then return false end`);
    add(`if ${cap('setfenv')} and (type(setfenv)~="function" or setfenv~=${cap('setfenv')}) then return false end`);
    add(`if ${cap('bit32')} and (bit32.bxor~=${cap('bit32')}.bxor or bit32.lshift~=${cap('bit32')}.lshift or bit32.rshift~=${cap('bit32')}.rshift) then return false end`);
    // A hook named by the shared getgenv()._vxwd marker belongs to an enclosing
    // VoidedX container, so it is accepted and then replaced: this loader writes
    // its own marker when it installs its watchdog, which is what lets an outer
    // armor layer and this bootstrap share one debug hook slot.
    add(`if ${cap('gethook')} then local ok,h=pcall(${cap('gethook')}) if ok and h~=nil and h~=${G.own} then`);
    add(`local mk=nil if ${cap('getgenv')} then local ook,gev=pcall(${cap('getgenv')}) if ook and type(gev)=="table" then mk=gev._vxwd end end`);
    add(`if h~=mk then return false end end end`);
    add(`if ${cap('sethook')} and (type(debug)~="table" or debug.sethook~=${cap('sethook')}) then return false end`);
    add(`if ${n.dmp} and string.dump~=${n.dmp} then return false end`);
    add(`if ${n.dmp} then`);
    add(`local ${DP.calib}=${cap('pcall')}(${n.dmp},${cap('byte')})`);
    add(`if not ${DP.calib} then`);
    add(`if ${cap('pcall')}(${n.dmp},${cap('load')}) then return false end`);
    add(`if ${cap('pcall')}(${n.dmp},${cap('error')}) then return false end`);
    add(`if ${cap('pcall')}(${n.dmp},${cap('concat')}) then return false end`);
    add(`if ${cap('pcall')}(${n.dmp},${cap('type')}) then return false end`);
    add(`if ${cap('pcall')}(${n.dmp},${cap('char')}) then return false end`);
    add(`end`);
    add(`end`);
    add(`local ${G.envs}={}`);
    add(`local function ${G.add}(e)`);
    add(`if type(e)~="table" then return end`);
    add(`for i=1,#${G.envs} do if ${G.envs}[i]==e then return end end`);
    add(`${G.envs}[#${G.envs}+1]=e`);
    add(`end`);
    add(`if ${n.gf} then local ok,e=pcall(${n.gf},0) if ok then ${G.add}(e) end end`);
    add(`if ${n.gv} then local ok,e=pcall(${n.gv}) if ok then ${G.add}(e) end end`);
    add(`for i=1,#${G.envs} do`);
    add(`local ls=${G.envs}[i].loadstring`);
    add(`local ld=${G.envs}[i].load`);
    add(`if ${n.lstr} and type(ls)=="function" and ls~=${n.lstr} then return false end`);
    add(`if ${n.ld} and type(ld)=="function" and ld~=${n.ld} then return false end`);
    add(`end`);
    add(`if ${n.dmp} then`);
    add(`if ${n.lstr} and pcall(${n.dmp},${n.lstr}) and ${n.ld} and type(${n.ld})=="function" and not pcall(${n.dmp},${n.ld}) then return false end`);
    add(`if ${n.ld} and pcall(${n.dmp},${n.ld}) and ${n.lstr} and type(${n.lstr})=="function" and not pcall(${n.dmp},${n.lstr}) then return false end`);
    add(`end`);
    add(`return true`);
    add(`end`);

    add(`local ${S}={}`);
    add(`${st('data')}={${dataLiteral}}`);
    add(`${st('sealed')}={${gateTable}}`);
    add(`${st('order')}={${probeOrder}}`);
    add(`${st('decoded')}={}`);
    add(`${st('fails')}=0`);
    add(`${st('rejected')}=0`);
    add(`${st('done')}=0`);
    add(`${st('deny')}=${luaString('Voided: Doing this is not allowed.')}`);
    add(`${st('expired')}=${luaString('[VoidedX] Error: Loader expired. Get a new loader from the website and try again.')}`);
    add(`${st('net')}=${luaString('[VoidedX] Could not reach the loader server. Your network or DNS blocked the request. Set DNS to 1.1.1.1 or turn off your VPN, then run the loader again.')}`);
    add(`${st('mark')}=${luaString(bootMark)}`);
    add(`${st('tail')}=${luaString(tailMark)}`);
    add(`${st('step')}=${partStep}`);
    add(`${st('chain')}=${chainSeed}`);
    add(`${st('spawn')}=type(task)=="table" and task.spawn or nil`);
    add(`${st('wait')}=type(task)=="table" and task.wait or nil`);
    add(`${st('session')}=${luaString(sessionId)}`);

    const P = loc('i', 'ok', 'res', 'hit');
    add(`local ${n.probeOne}=function(${P.i})`);
    add(`local ${P.ok},${P.res}=pcall(function() return ${cap('http')}(game,${st('decoded')}[${st('order')}[${P.i}]]) end)`);
    add(`if ${P.ok} and type(${P.res})=="string" then`);
    add(`local ${P.hit}=${cap('match')}(${P.res},"^vx1|(%x%x%x%x%x%x%x%x)|%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x$")`);
    add(`if ${P.hit} and not ${st('seed')} then ${st('seed')}=${P.hit} end`);
    add(`elseif not ${P.ok} then`);
    add(`if ${cap('match')}(${cap('tostring')}(${P.res}),"410") then ${st('rejected')}=${st('rejected')}+1 else ${st('fails')}=${st('fails')}+1 end`);
    add(`end`);
    add(`${st('done')}=${st('done')}+1`);
    add(`end`);

    const H = new Map();
    const O = loc('i', 'e', 'ok', 'f', 'l', 'v');
    H.set('guardA', [
        `if not ${n.guard}() then error(${st('deny')},0) end`
    ]);
    H.set('openUrls', [
        `for ${O.i}=1,#${st('sealed')} do local ${O.e}=${st('sealed')}[${O.i}] ${st('decoded')}[${O.i}]=${n.dec}(${O.e}[1],${O.e}[2])..${n.dec}(${O.e}[3],${O.e}[4]) end`
    ]);
    H.set('probe', [
        `if ${st('spawn')} and ${st('wait')} then`,
        `for ${O.i}=1,#${st('order')} do pcall(${st('spawn')},${n.probeOne},${O.i}) end`,
        `local ${O.v}=0`,
        `while ${st('done')}<#${st('order')} and not ${st('seed')} and ${O.v}<600 do ${O.v}=${O.v}+1 pcall(${st('wait')},0.01) end`,
        `else`,
        `local ${O.i}=1`,
        `while ${O.i}<=#${st('order')} and not ${st('seed')} do ${n.probeOne}(${O.i}) ${O.i}=${O.i}+1 end`,
        `while ${O.i}<=#${st('order')} do ${n.probeOne}(${O.i}) ${O.i}=${O.i}+1 end`,
        `end`,
        `if not ${st('seed')} then`,
        `if ${st('fails')}>=#${st('order')} and ${st('rejected')}==0 then error(${st('net')},0) end`,
        `error(${st('expired')},0)`,
        `end`
    ]);
    H.set('guardB', [
        `if ${cap('httpStable')} and game.HttpGet~=${cap('http')} then error(${st('deny')},0) end`,
        `if not ${n.guard}() then error(${st('deny')},0) end`
    ]);
    H.set('select', [
        `local ${O.l}=${cap('load')}`,
        `if ${n.ld} and ${n.ld}~=${O.l} then local ${O.ok},${O.f}=pcall(${n.ld},"return 1") if ${O.ok} and type(${O.f})=="function" then ${O.l}=${n.ld} end end`,
        `if type(${O.l})~="function" then error("[VoidedX] This executor does not support loadstring.",0) end`,
        `${st('loader')}=${O.l}`
    ]);
    H.set('decode', [
        `local ${O.v}=tonumber(${st('seed')},16)`,
        `local ${O.f}=${st('chain')}`,
        `local ${O.e}={}`,
        `for ${O.i}=1,#${st('data')} do`,
        `local ${O.ok}=(${O.v}+(${O.i}-1)*${st('step')})%4294967296`,
        `${O.ok}=bit32.bxor(${O.ok},${O.f})`,
        `local ${O.l}=${n.dec}(${st('data')}[${O.i}],${O.ok})`,
        `if ${O.i}==1 and ${cap('sub')}(${O.l},1,#${st('mark')})~=${st('mark')} then error(${st('expired')},0) end`,
        `${O.e}[${O.i}]=${O.l}`,
        `${O.f}=${n.sum}(${O.l})`,
        `end`,
        `local ${O.l}=${cap('concat')}(${O.e})`,
        `if ${cap('sub')}(${O.l},-#${st('tail')})~=${st('tail')} then error(${st('expired')},0) end`,
        `${st('code')}=${O.l}`
    ]);
    const AS = loc('c', 'a', 'ok', 'f', 'pos', 'p');
    H.set('assemble', [
        `local ${AS.c}=${st('code')}`,
        `local ${AS.a}=${AS.c}`,
        `local ${AS.ok},${AS.f}=pcall(${st('loader')},function() return nil end)`,
        `if ${AS.ok} and type(${AS.f})=="function" then`,
        `local ${AS.pos}=0`,
        `${AS.a}=function()`,
        `if ${AS.pos}>=#${AS.c} then return nil end`,
        `local ${AS.p}=${cap('sub')}(${AS.c},${AS.pos}+1,${AS.pos}+4096)`,
        `${AS.pos}=${AS.pos}+4096`,
        `return ${AS.p}`,
        `end`,
        `end`,
        `${st('arg')}=${AS.a}`
    ]);
    const C = loc('f', 'e');
    H.set('compile', [
        `local ${C.f},${C.e}=${st('loader')}(${st('arg')},"=${chunkName}")`,
        `if not ${C.f} then error(${cap('tostring')}(${C.e}),0) end`,
        `${st('chunk')}=${C.f}`
    ]);
    const HK = loc('env', 'ok', 'e', 'ticks', 'off', 'wd', 'h');
    H.set('hook', [
        `local ${HK.env}=nil`,
        `if ${n.gv} then local ${HK.ok},${HK.e}=pcall(${n.gv}) if ${HK.ok} and type(${HK.e})=="table" then ${HK.env}=${HK.e} end end`,
        `${st('env')}=${HK.env}`,
        `if ${cap('sethook')} and ${cap('gethook')} then`,
        `local ${HK.ticks}=0`,
        `local ${HK.off}=function()`,
        `local ${HK.ok},${HK.h}=pcall(${cap('gethook')})`,
        `if ${HK.ok} and ${HK.h}==${st('wd')} then pcall(${cap('sethook')}) end`,
        `if ${st('env')} then pcall(function() if ${st('env')}._vxwd==${st('wd')} then ${st('env')}._vxwd=nil end end) end`,
        `end`,
        `local ${HK.wd}=function()`,
        `${HK.ticks}=${HK.ticks}+1`,
        `if string.byte~=${cap('byte')} or string.char~=${cap('char')} or string.sub~=${cap('sub')} or string.gsub~=${cap('gsub')} or string.match~=${cap('match')} or table.concat~=${cap('concat')} or pcall~=${cap('pcall')} or type~=${cap('type')} or math.floor~=${cap('floor')} or error~=${cap('error')} then pcall(${cap('sethook')}) error(${st('deny')},0) end`,
        `if ${cap('sethook')} and debug.sethook~=${cap('sethook')} then pcall(${cap('sethook')}) error(${st('deny')},0) end`,
        `local ${HK.ok},${HK.h}=pcall(${cap('gethook')})`,
        `if ${HK.ok} and ${HK.h}~=nil and ${HK.h}~=${HK.wd} then pcall(${cap('sethook')}) error(${st('deny')},0) end`,
        `if ${HK.ticks}>=64 then ${HK.off}() end`,
        `end`,
        `if pcall(${cap('sethook')},${HK.wd},"",250000) then`,
        `local ${HK.ok},${HK.h}=pcall(${cap('gethook')})`,
        `if ${HK.ok} and ${HK.h}==${HK.wd} then`,
        `if ${st('env')} then pcall(function() ${st('env')}._vxwd=${HK.wd} end) end`,
        `if type(task)=="table" and type(task.delay)=="function" then pcall(task.delay,10,${HK.off}) end`,
        `else pcall(${cap('sethook')}) end`,
        `end`,
        `${st('wd')}=${HK.wd}`,
        `${st('off')}=${HK.off}`,
        `end`
    ]);
    H.set('guardC', [
        `if not ${n.guard}(${st('wd')}) then if ${cap('sethook')} then pcall(${cap('sethook')}) end error(${st('deny')},0) end`
    ]);
    H.set('run', [
        `return ${st('chunk')}()`
    ]);
    // Executor file APIs, when they exist, are used only to leave a per-run
    // marker: nothing about the payload, the key or the session is stored, so a
    // file on disk can never be turned into a dump.
    const BS = loc('path', 'old', 'ok');
    H.set('beacon', [
        `if ${cap('writefile')} and ${cap('readfile')} and ${cap('isfile')} then`,
        `pcall(function()`,
        `local ${BS.path}="voidedx_${fileTag}.mx"`,
        `local ${BS.old}=${cap('isfile')}(${BS.path}) and ${cap('readfile')}(${BS.path}) or nil`,
        `if type(${BS.old})=="string" and ${cap('sub')}(${BS.old},1,32)==${st('session')} then return end`,
        `${cap('writefile')}(${BS.path},${st('session')})`,
        `end)`,
        `end`
    ]);
    H.set('noop', []);

    const order = ['guardA', 'openUrls', ...bootShuffle(['probe', 'select']), 'guardB', 'decode', 'assemble', 'compile', 'hook', 'guardC'];
    if (randomBytes(1)[0] % 2 === 0) {
        order.splice(1 + (randomBytes(1)[0] % (order.length - 1)), 0, 'noop');
    }
    order.push('beacon', 'run');

    const opcodeNames = bootShuffle(Array.from(H.keys()));
    const opcodePool = bootShuffle(Array.from({ length: 120 }, (_, index) => index + 1)).slice(0, opcodeNames.length);
    const opcode = {};
    opcodeNames.forEach((name, index) => { opcode[name] = opcodePool[index]; });

    add(`local ${n.handlerTable}={}`);
    const junkFactory = createConfusableFactory(() => randomBytes(4).readUInt32BE(0) / 4294967296);
    const junkRng = () => randomBytes(4).readUInt32BE(0) / 4294967296;
    for (const name of bootShuffle(Array.from(H.keys()))) {
        if (randomBytes(1)[0] % 3 === 0) {
            add(randomBytes(1)[0] % 2 === 0
                ? buildStateMachineJunk(junkRng, junkFactory)
                : buildRegisterMachineJunk(junkRng, junkFactory));
        }
        add(`${n.handlerTable}[${opcode[name]}]=function()`);
        for (const line of H.get(name)) add(line);
        add(`end`);
    }

    const seqBuffer = Buffer.from(order.map(name => opcode[name] & 0xFF));
    const seqKey = randomBytes(4).readUInt32BE(0) || 1;
    const seqLiteral = sealBlob(seqBuffer, seqKey);
    const seqSum = bootChainSum(seqBuffer, hash);

    const Q = loc('raw', 'i', 'f', 'v', 'a', 'b', 't0');
    add(`local ${Q.raw}=${n.dec}("${seqLiteral}",${seqKey})`);
    add(`if ${n.sum}(${Q.raw})~=${seqSum} then error(${st('deny')},0) end`);
    add(`local ${n.seq}={}`);
    add(`for ${Q.i}=1,#${Q.raw} do ${n.seq}[${Q.i}]=string.byte(${Q.raw},${Q.i}) end`);
    const swapMod = 2 + randomBytes(1)[0] % 3;
    add(`local ${n.main}=function()`);
    add(`local ${Q.t0}=os.clock()`);
    add(`for ${Q.i}=1,#${n.seq} do`);
    add(`local ${Q.f}=${n.handlerTable}[${n.seq}[${Q.i}]]`);
    add(`if not ${Q.f} then return error(${st('deny')},0) end`);
    add(`local ${Q.v}=${Q.f}()`);
    add(`if ${Q.v}~=nil then return ${Q.v} end`);
    add(`if ${Q.i}%${swapMod}==0 then`);
    add(`local ${Q.a},${Q.b}=${n.seq}[${Q.i}+1],${n.seq}[${Q.i}+2]`);
    add(`if ${Q.a} and ${Q.b} and ${Q.a}~=${Q.b} then`);
    add(`${n.handlerTable}[${Q.a}],${n.handlerTable}[${Q.b}]=${n.handlerTable}[${Q.b}],${n.handlerTable}[${Q.a}]`);
    add(`${n.seq}[${Q.i}+1],${n.seq}[${Q.i}+2]=${Q.b},${Q.a}`);
    add(`end`);
    add(`end`);
    add(`end`);
    add(`if os.clock()-${Q.t0}>${6 + randomBytes(1)[0] % 6} then return error(${st('deny')},0) end`);
    add(`end`);
    add(`return ${n.main}()`);

    return armorBootstrap(lines.join('\n'));
}

export function buildPayloadRuntime(origin, options = {}, id = '') {
    const instant = options.instant === true;
    // Instant loaders carry no progress renderer at all, so the only console
    // output they can produce is the VoidedX credit line.
    const progressPrinter = instant
        ? 'local function vxProgress() end'
        : `local vxLastProgressBlocks, vxLastProgressStage
local function vxProgress(percent, stage)
    percent = math.max(0, math.min(100, math.floor(percent)))
    local width = 14
    local filled = math.floor(width * percent / 100)
    if filled == vxLastProgressBlocks and stage == vxLastProgressStage then return end
    vxLastProgressBlocks = filled
    vxLastProgressStage = stage
    local line = vxFormat(
        "[VoidedX] [%s%s] %3d%%  %s",
        vxRep("=", filled),
        vxRep("-", width - filled),
        percent,
        stage
    )
    vxPcall(vxPrint, line)
end`;
    const payloadBase = luaString(`${origin}/api/payload?session=`);
    const hasRawPath = typeof id === 'string' && id.length > 0;
    const getRawBase = luaString(`${origin}/get/raw/${encodeURIComponent(id || '')}/`);
    const integrityBase = luaString(`${origin}/api/integrity?session=`);
    return `
local vxPayloadBase = ${payloadBase}
local vxGetRawPath = ${hasRawPath ? 'true' : 'false'}
local vxGetRawBase = ${getRawBase}
local vxIntegrityBase = ${integrityBase}
local vxBit = bit32
if type(vxBit) ~= "table" then
    return error("[VoidedX] Your executor is missing the Lua runtime this loader needs.", 0)
end
local vxBxor, vxLshift, vxRshift, vxBand = vxBit.bxor, vxBit.lshift, vxBit.rshift, vxBit.band
-- Some executors build game.HttpGet on each access; only trust identity when it is stable.
local vxHttpGet = game.HttpGet
local vxHttpGetStable = game.HttpGet == game.HttpGet
local vxLoad = loadstring or load
-- Prefer the other native compile entry when both exist: a logger that only
-- wraps loadstring never sees the armored payload, and vice versa.
local vxLoadAlt = (loadstring and load and loadstring ~= load) and ((vxLoad == loadstring) and load or loadstring) or nil
if type(vxLoadAlt) == "function" then
    local vxAltOk, vxAltProbe = pcall(vxLoadAlt, "return 1")
    if vxAltOk and type(vxAltProbe) == "function" then vxLoad = vxLoadAlt end
end
local vxLoadStable = (loadstring or load) == vxLoad
local vxJsonDecode = HttpService.JSONDecode
local vxJsonStable = HttpService.JSONDecode == vxJsonDecode
local vxChar = string.char
local vxByte = string.byte
local vxSub = string.sub
local vxFormat = string.format
local vxRep = string.rep
local vxConcat = table.concat
local vxGsub = string.gsub
local vxMatch = string.match
local vxLower = string.lower
local vxPcall = pcall
local vxInfo = type(debug) == "table" and debug.info or nil
local vxInfoStable = vxInfo ~= nil and debug.info == vxInfo
local vxRawEqual = rawequal
-- Snapshot the runtime pieces a hook would have to replace. Identity is only
-- trusted for accessors that returned the same function twice at startup, since
-- some executors build a fresh closure on every read.
local vxDump = string.dump
local vxDumpStable = vxDump ~= nil and string.dump == vxDump
local vxSetHook = type(debug) == "table" and debug.sethook or nil
local vxSetHookStable = vxSetHook ~= nil and debug.sethook == vxSetHook
local vxGetHook = type(debug) == "table" and debug.gethook or nil
local vxGetHookStable = vxGetHook ~= nil and debug.gethook == vxGetHook
local vxGetfenv = type(getfenv) == "function" and getfenv or nil
local vxGetfenvStable = vxGetfenv ~= nil and getfenv == vxGetfenv
local vxSetfenv = type(setfenv) == "function" and setfenv or nil
local vxSetfenvStable = vxSetfenv ~= nil and setfenv == vxSetfenv
local vxErrorStable = error == vxError
local vxPrint = print
local vxTostring = tostring
local vxTonumber = tonumber
local vxTypeOf = type
local vxError = error
local vxNext = next
local vxIpairs = ipairs
local vxSetmetatable = setmetatable
local vxRawset = rawset
local vxFloor = math.floor
local vxGetgenv = type(getgenv) == "function" and getgenv or nil
local vxShared = type(shared) == "table" and shared or nil
local vxGetService = game.GetService
local vxServiceStable = game.GetService == game.GetService
local vxUrlEncode = HttpService.UrlEncode
local vxUrlEncodeStable = HttpService.UrlEncode == HttpService.UrlEncode
local vxTaskWait = type(task) == "table" and task.wait or nil
local vxTaskSpawn = type(task) == "table" and task.spawn or nil

-- Two independent ways to reach the server. game.HttpGet goes first because every
-- executor has it; when it is blocked, rate limited or hooked, the same request
-- leaves through the engine's async HTTP call or the executor's own request
-- function, so a loader is not stranded by whichever one a host disables.
local function vxFetch(url)
    local ok, res = vxPcall(function() return vxHttpGet(game, url) end)
    if ok and type(res) == "string" then return true, res end
    local last = res
    if type(HttpService) == "table" and type(HttpService.RequestAsync) == "function" then
        local ok2, res2 = vxPcall(function() return HttpService:RequestAsync({ Url = url, Method = "GET" }) end)
        if ok2 and type(res2) == "table" and res2.Success ~= false and type(res2.Body) == "string" then return true, res2.Body end
        last = res2 or last
    else
        local alt = http_request or request or (syn and syn.request) or (flux and flux.request)
        if type(alt) == "function" then
            local ok3, res3 = vxPcall(function() return alt({ Url = url, Method = "GET" }) end)
            if ok3 and type(res3) == "table" and type(res3.Body) == "string" then return true, res3.Body end
            last = res3 or last
        end
    end
    return false, last
end
local function vxPlaceParam()
    local place = game and game.PlaceId
    if type(place) == "number" then return "&placeId=" .. vxTostring(place) end
    return ""
end

local function vxEncode(value)
    local text = vxTostring(value or "")
    local ok, encoded = vxPcall(vxUrlEncode, HttpService, text)
    if ok and type(encoded) == "string" then return encoded end
    return (vxGsub(text, "[^%w%-%._~]", function(char)
        return vxFormat("%%%02X", vxByte(char))
    end))
end

-- Everything the owner dashboard groups executions by travels on the verify
-- call. Executor APIs differ, so each probe is guarded and simply omitted when
-- the function is missing.
local function vxClientParams(player)
    local params = ""
    if player then
        params = params .. "&userId=" .. vxTostring(player.UserId)
        local nameOk, name = vxPcall(function() return player.Name end)
        if nameOk and type(name) == "string" and name ~= "" then
            params = params .. "&username=" .. vxEncode(vxSub(name, 1, 32))
        end
    end
    -- Executor identity: identifyexecutor first, then the aliases other executors expose.
    local executor = nil
    if type(identifyexecutor) == "function" then
        local ok, value = vxPcall(identifyexecutor)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if not executor and type(getexecutorname) == "function" then
        local ok, value = vxPcall(getexecutorname)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if not executor and type(syn) == "table" and type(syn.get_executor) == "function" then
        local ok, value = vxPcall(function() return syn.get_executor() end)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if type(executor) == "string" and executor ~= "" then
        params = params .. "&executor=" .. vxEncode(vxSub(executor, 1, 40))
    end
    -- Device identity only: gethwid, then getserial, then the client's own analytics id.
    local hwid = nil
    if type(gethwid) == "function" then
        local ok, value = vxPcall(gethwid)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid and type(getserial) == "function" then
        local ok, value = vxPcall(getserial)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid and type(syn) == "table" and type(syn.get_hwid) == "function" then
        local ok, value = vxPcall(function() return syn.get_hwid() end)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid then
        local serviceOk, analytics = vxPcall(function() return game:GetService("RbxAnalyticsService") end)
        if serviceOk and analytics then
            local ok, value = vxPcall(function() return analytics:GetClientId() end)
            if ok and type(value) == "string" and value ~= "" then hwid = value end
        end
    end
    if type(hwid) == "string" and hwid ~= "" then
        params = params .. "&hwid=" .. vxEncode(vxSub(hwid, 1, 96))
    end
    return params .. vxPlaceParam()
end

vxPcall(vxPrint, "[VoidedX] VoidedX Protection - protect your scripts at https://voidedx.vercel.app")

local vxInstant = ${instant ? 'true' : 'false'}

local vxB64Map = {}
do
    local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for index = 1, #alphabet do vxB64Map[vxByte(alphabet, index)] = index - 1 end
    -- base64url: fold - and _ into the same byte-keyed map instead of rewriting
    -- the whole payload twice with gsub before decoding.
    vxB64Map[45] = 62
    vxB64Map[95] = 63
end

local function vxNextState(state)
    state = vxBxor(state, vxLshift(state, 13))
    state = vxBxor(state, vxRshift(state, 17))
    return vxBxor(state, vxLshift(state, 5))
end

local vxCrcTable
local function vxCrcInit()
    if vxCrcTable then return end
    vxCrcTable = {}
    for index = 0, 255 do
        local current = index
        for _ = 1, 8 do
            if current % 2 == 1 then current = vxBxor(vxRshift(current, 1), 0xEDB88320)
            else current = vxRshift(current, 1) end
        end
        vxCrcTable[index] = current
    end
end

-- Decodes every part and folds the CRC32 into the same pass, so the integrity
-- check never re-reads the payload. The checksum still covers the ciphertext as
-- received, and it is compared before anything is decrypted.
local function vxDecodeParts(parts, count)
    vxCrcInit()
    local crc = 0xFFFFFFFF
    local out = {}
    local o = 0
    for part = 1, count do
        local value = parts[part]
        local remainder = #value % 4
        if remainder == 2 then value = value .. "=="
        elseif remainder == 3 then value = value .. "=" end
        local length = #value
        local block = {}
        local k = 0
        local pos = 1
        while pos <= length do
            local c1, c2, c3, c4 = vxByte(value, pos, pos + 3)
            local q1, q2 = vxB64Map[c1], vxB64Map[c2]
            local q3, q4 = vxB64Map[c3], vxB64Map[c4]
            local packed = (q1 or 0) * 262144 + (q2 or 0) * 4096 + (q3 or 0) * 64 + (q4 or 0)
            local b1 = vxRshift(packed, 16)
            local b2 = vxBand(vxRshift(packed, 8), 255)
            local b3 = vxBand(packed, 255)
            crc = vxBxor(vxCrcTable[vxBxor(vxBand(crc, 255), b1)], vxRshift(crc, 8))
            if q3 then
                crc = vxBxor(vxCrcTable[vxBxor(vxBand(crc, 255), b2)], vxRshift(crc, 8))
                if q4 then
                    crc = vxBxor(vxCrcTable[vxBxor(vxBand(crc, 255), b3)], vxRshift(crc, 8))
                    k = k + 1 block[k] = vxChar(b1, b2, b3)
                else
                    k = k + 1 block[k] = vxChar(b1, b2)
                end
            else
                k = k + 1 block[k] = vxChar(b1)
            end
            if k >= 2048 then
                o = o + 1 out[o] = vxConcat(block)
                block = {}
                k = 0
            end
            pos = pos + 4
        end
        if k > 0 then o = o + 1 out[o] = vxConcat(block) end
    end
    return vxConcat(out), vxFormat("%08x", vxBxor(crc, 0xFFFFFFFF))
end

-- One keystream step per 32-bit word, one string.char call per word.
local function vxXor(value, state)
    local length = #value
    local out = {}
    local o = 0
    local block = {}
    local k = 0
    local pos = 1
    while pos <= length do
        state = vxNextState(state)
        local m1 = vxBand(vxRshift(state, 24), 255)
        local m2 = vxBand(vxRshift(state, 16), 255)
        local m3 = vxBand(vxRshift(state, 8), 255)
        local m4 = vxBand(state, 255)
        local b1, b2, b3, b4 = vxByte(value, pos, pos + 3)
        if b4 then k = k + 1 block[k] = vxChar(vxBxor(b1, m1), vxBxor(b2, m2), vxBxor(b3, m3), vxBxor(b4, m4))
        elseif b3 then k = k + 1 block[k] = vxChar(vxBxor(b1, m1), vxBxor(b2, m2), vxBxor(b3, m3))
        elseif b2 then k = k + 1 block[k] = vxChar(vxBxor(b1, m1), vxBxor(b2, m2))
        else k = k + 1 block[k] = vxChar(vxBxor(b1, m1)) end
        if k >= 2048 then
            o = o + 1 out[o] = vxConcat(block)
            block = {}
            k = 0
        end
        pos = pos + 4
    end
    if k > 0 then o = o + 1 out[o] = vxConcat(block) end
    return vxConcat(out)
end

local function vxCollectFlags()
    local flags = {}
    local function add(name)
        for index = 1, #flags do
            if flags[index] == name then return end
        end
        flags[#flags + 1] = name
    end
    if vxHttpGetStable and game.HttpGet ~= vxHttpGet then add("http_swapped") end
    if vxLoadStable and (loadstring or load) ~= vxLoad then add("load_swapped") end
    if vxJsonStable and HttpService.JSONDecode ~= vxJsonDecode then add("json_swapped") end
    if string.char ~= vxChar or string.byte ~= vxByte or string.sub ~= vxSub then add("string_swapped") end
    if table.concat ~= vxConcat then add("table_swapped") end
    if pcall ~= vxPcall then add("pcall_swapped") end
    if rawequal ~= vxRawEqual then add("rawequal_swapped") end
    if vxInfoStable and (type(debug) ~= "table" or debug.info ~= vxInfo) then add("debug_swapped") end
    if print ~= vxPrint then add("print_swapped") end
    if tostring ~= vxTostring or tonumber ~= vxTonumber or type ~= vxTypeOf
        or next ~= vxNext or ipairs ~= vxIpairs
        or setmetatable ~= vxSetmetatable or rawset ~= vxRawset
        or math.floor ~= vxFloor then
        add("builtin_swapped")
    end
    if string.format ~= vxFormat or string.rep ~= vxRep or string.gsub ~= vxGsub or string.match ~= vxMatch then
        add("builtin_swapped")
    end
    if vxGetgenv and (type(getgenv) ~= "function" or getgenv ~= vxGetgenv) then add("env_swapped") end
    if vxServiceStable and game.GetService ~= vxGetService then add("service_swapped") end
    if vxUrlEncodeStable and HttpService.UrlEncode ~= vxUrlEncode then add("urlencode_swapped") end
    if (vxTaskWait and task.wait ~= vxTaskWait) or (vxTaskSpawn and task.spawn ~= vxTaskSpawn) then
        add("task_swapped")
    end
    if vxDumpStable and string.dump ~= vxDump then add("dump_swapped") end
    if vxErrorStable and error ~= vxError then add("error_swapped") end
    if vxSetHookStable and (type(debug) ~= "table" or debug.sethook ~= vxSetHook) then add("hook_swapped") end
    if vxGetHookStable and (type(debug) ~= "table" or debug.gethook ~= vxGetHook) then add("hook_swapped") end
    if vxGetfenvStable and (type(getfenv) ~= "function" or getfenv ~= vxGetfenv) then add("fenv_swapped") end
    if vxSetfenvStable and (type(setfenv) ~= "function" or setfenv ~= vxSetfenv) then add("fenv_swapped") end
    -- The bootstrap marks getgenv with the watchdog it installed. If that mark
    -- survives but gethook reports a different function, the watchdog was
    -- replaced. Only trusted when getgenv returns the same table twice, since
    -- some executors build a fresh environment on every call.
    if vxGetHookStable and vxGetgenv then
        local hookOk, hookFn = vxPcall(vxGetHook)
        local envOk1, env1 = vxPcall(vxGetgenv)
        local envOk2, env2 = vxPcall(vxGetgenv)
        if hookOk and envOk1 and envOk2 and vxTypeOf(hookFn) == "function"
            and vxTypeOf(env1) == "table" and env1 == env2 and env1._vxwd ~= nil
            and env1._vxwd ~= hookFn then
            add("hook_installed")
        end
    end
    return flags
end

local function vxReport(report, trace, flags)
    if type(report) ~= "string" or report == "" or #flags == 0 then return false end
    local safe = {}
    for index = 1, #flags do
        if vxMatch(flags[index], "^[a-z_]+$") then safe[#safe + 1] = flags[index] end
    end
    if #safe == 0 then return false end
    local url = vxIntegrityBase .. report
        .. "&trace=" .. vxGsub(trace or "", "[^%x]", "")
        .. "&flags=" .. vxConcat(safe, ",")
    local ok, response = vxPcall(function() return vxHttpGet(game, url) end)
    if not ok or type(response) ~= "string" then return false end
    local decodedOk, decoded = vxPcall(vxJsonDecode, HttpService, response)
    return decodedOk and type(decoded) == "table" and decoded.block == true
end

${progressPrinter}

-- A delivery opened through the full link comes back with its field names
-- re-labelled and a small map saying where they went. Without the map the classic
-- names are used, so a payload served to an older loader still parses.
local function vxReplyName(result, code, fallback)
    local map = type(result.k) == "table" and result.k or nil
    if map and type(map[code]) == "string" then return map[code] end
    return fallback
end

-- Same fold the delivery route applies: the session seed mixed with both halves of
-- the one-time link that just opened this delivery. The link is destroyed by the
-- request, so the key that decodes a body cannot be rebuilt from an archived
-- response and a captured session seed. The client reproduces this from the URL it
-- just used, with plain hex reads - no hashing in Lua.
--
-- The multiply is split into 16-bit halves on purpose. A direct a*b reaches 2^57,
-- which is exact on Luau and Lua 5.4 integers but silently rounds on a host whose
-- numbers are doubles, and a rounded key means "the payload failed its integrity
-- check" for those players. This form never exceeds 2^41, so every host lands on
-- the same 32 bits as the server.
local function vxRunawaySeed(seed, code, hop)
    -- Mirrors the route: a zero seed is replaced, never folded from.
    local value = seed
    if value == 0 then value = 2654435769 end
    local halves = { code, hop }
    for index = 1, 2 do
        local half = halves[index]
        for offset = 1, #half - 7, 8 do
            local word = vxTonumber(vxSub(half, offset, offset + 7), 16)
            if word then
                local mixed = vxBxor(value, word)
                local low = mixed % 65536
                local high = math.floor((mixed - low) / 65536)
                value = ((low * 16777619 + (high * 16777619) % 65536 * 65536) + word) % 4294967296
            end
        end
    end
    return value
end

local function vxUnshield(result, shield, delivery, hop)
    local partsField = vxReplyName(result, "p", "parts")
    local tagField = vxReplyName(result, "t", "tag")
    if type(result[partsField]) ~= "table" then
        return nil, "payload_shape_invalid"
    end
    local parts = result[partsField]
    local count = #parts
    if count < 1 or count > 64 then
        return nil, "payload_shape_invalid"
    end
    local chunks = {}
    for index = 1, count do
        if type(parts[index]) ~= "string" then return nil, "payload_shape_invalid" end
        chunks[index] = parts[index]
    end
    -- The checksum covers the ciphertext as received. It proves the transfer was
    -- intact without publishing a checksum of the plaintext to calibrate against.
    local cipher, crc = vxDecodeParts(chunks, count)
    if crc ~= vxLower(vxTostring(result[tagField] or "")) then
        return nil, "payload_crc_mismatch"
    end
    local seed = vxTonumber(shield.key, 16)
    if not seed then return nil, "payload_shape_invalid" end
    if type(delivery) == "string" and #delivery == 32 and type(hop) == "string" and #hop == 32 then
        seed = vxRunawaySeed(seed, delivery, hop)
    end
    local code = vxXor(cipher, seed)
    local prefix = "--[[vx:" .. shield.trace .. "]]"
    if vxSub(code, 1, #prefix) ~= prefix then return nil, "watermark_missing" end
    return code
end

local function vxRunPayload(token, userId, shield, report, delivery, hop)
    if type(token) ~= "string" or token == "" then
        return error("[VoidedX] The server did not issue a delivery ticket.", 0)
    end
    if type(shield) ~= "table"
        or type(shield.key) ~= "string"
        or type(shield.trace) ~= "string" then
        return error("[VoidedX] The server did not issue a protected payload. Get a new loader from the website.", 0)
    end

    -- Honeypots. Nothing in this loader calls these functions. They are published
    -- under getgenv().VoidedX so anyone who finds the loaded chunk and tries to
    -- poke at its "unlock" or "dump" helpers reports themselves to /api/integrity
    -- before the payload is requested. Reading an unknown field trips the guard
    -- too, which catches tools that enumerate the table.
    local function vxHoneypotHit()
        vxReport(report, shield.trace, { "honeypot_triggered" })
        return vxError("[VoidedX] This loader was modified. Get a new loader from the website.", 0)
    end

    local function vxDecoyUnlock()
        return vxHoneypotHit()
    end

    local function vxDecoyDump()
        return vxHoneypotHit()
    end

    if vxGetgenv then
        local envOk, env = vxPcall(vxGetgenv)
        if envOk and vxTypeOf(env) == "table" then
            local decoy = {
                unlock = vxDecoyUnlock,
                bypass = vxDecoyUnlock,
                signature = vxDecoyDump,
                extract = vxDecoyDump,
                payload = vxDecoyDump,
                key = vxDecoyUnlock,
                token = vxDecoyDump,
                session = vxDecoyDump
            }
            local armed = vxPcall(function()
                vxSetmetatable(decoy, {
                    __index = function()
                        return vxHoneypotHit()
                    end,
                    __newindex = function(self, name, value)
                        vxRawset(self, name, value)
                        return vxHoneypotHit()
                    end
                })
            end)
            if armed then
                vxPcall(function() env.VoidedX = decoy end)
                if vxShared then vxPcall(function() vxShared.VoidedX = decoy end) end
            end
        end
    end

    local flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    local suffix = ""
    if userId ~= nil then suffix = suffix .. "&userId=" .. HttpService:UrlEncode(tostring(userId)) end
    local vxPlaceId = game and game.PlaceId
    if type(vxPlaceId) == "number" then suffix = suffix .. "&placeId=" .. vxTostring(vxPlaceId) end

    local payloadUrl, fallbackUrl
    local linkHop = (type(hop) == "string" and #hop == 32) and hop or nil
    if vxGetRawPath and type(delivery) == "string" and #delivery == 32 then
        payloadUrl = vxGetRawBase .. HttpService:UrlEncode(delivery)
            .. (linkHop and ("/" .. HttpService:UrlEncode(linkHop)) or "")
            .. "?" .. vxSub(suffix, 2)
        fallbackUrl = vxPayloadBase .. HttpService:UrlEncode(token) .. suffix
    else
        payloadUrl = vxPayloadBase .. HttpService:UrlEncode(token) .. suffix
    end

    local candidates = { payloadUrl }
    if fallbackUrl then candidates[2] = fallbackUrl end

    local executionCode, reason
    for _, candidate in ipairs(candidates) do
        local canFallback = fallbackUrl ~= nil and candidate == payloadUrl
        local requestOk, response
        local requestDone = false
        local progress = 2
        vxProgress(progress, "Connecting to server")

        local asyncStarted = false
        if not vxInstant and type(task) == "table" and type(task.spawn) == "function" and type(task.wait) == "function" then
            asyncStarted = vxPcall(function()
                task.spawn(function()
                    requestOk, response = vxFetch(candidate)
                    requestDone = true
                end)
            end)
        end

        if asyncStarted then
            while not requestDone do
                progress = math.min(progress + 6, 85)
                vxProgress(progress, "Downloading payload")
                task.wait(0.2)
            end
        else
            vxProgress(40, "Downloading payload")
            requestOk, response = vxFetch(candidate)
        end

        if not requestOk then
            if canFallback then
                vxProgress(progress, "Retrying delivery")
            else
                vxProgress(progress, "Download failed")
                return error("[VoidedX] Could not download the script: " .. tostring(response), 0)
            end
        else
            flags = vxCollectFlags()
            if #flags > 0 and vxReport(report, shield.trace, flags) then
                return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
            end

            vxProgress(90, "Verifying payload")
            local decodeOk, decoded = vxPcall(vxJsonDecode, HttpService, response)
            if not decodeOk or type(decoded) ~= "table" then
                if canFallback then
                    vxProgress(90, "Retrying delivery")
                else
                    vxProgress(90, "Server error")
                    return error("[VoidedX] The payload server returned a bad response.", 0)
                end
            elseif not decoded[vxReplyName(decoded, "s", "ok")] then
                if canFallback then
                    vxProgress(90, "Retrying delivery")
                else
                    vxProgress(90, "Access denied")
                    return error("[VoidedX] " .. tostring(decoded.message or "The script could not be delivered."), 0)
                end
            elseif decoded[vxReplyName(decoded, "v", "v")] ~= 5 then
                if canFallback then
                    vxProgress(90, "Retrying delivery")
                else
                    vxProgress(90, "Invalid payload")
                    return error("[VoidedX] The payload server returned no script. Run the loader again.", 0)
                end
            else
                -- Only the paired path link is served under the runaway key. The
                -- ticket form is a different request and the server leaves its body
                -- on the plain session seed, so folding here would fail every
                -- fallback delivery - which is what "Invalid payload" meant.
                local foldHop = (candidate == payloadUrl and linkHop ~= nil) and linkHop or nil
                local verified, verifyReason = vxUnshield(decoded, shield, delivery, foldHop)
                if verified then
                    executionCode = verified
                    break
                end
                -- The body arrived but did not verify. That is normally a clipped
                -- or rewritten response on this URL, and the other candidate is a
                -- different request, so spend it before giving up. Before this the
                -- loader tried the second hop, failed once and stopped.
                reason = verifyReason
                if fallbackUrl ~= nil and candidate == payloadUrl then
                    vxProgress(90, "Retrying delivery")
                else
                    vxProgress(90, "Invalid payload")
                    vxReport(report, shield.trace, { reason })
                    return error("[VoidedX] The payload failed its integrity check. Run the loader again.", 0)
                end
            end
        end
    end

    if not executionCode then
        if reason then vxReport(report, shield.trace, { reason }) end
        return error("[VoidedX] The payload failed its integrity check. Run the loader again.", 0)
    end
    vxProgress(95, "Integrity verified")

    flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    vxProgress(97, "Compiling")
    local compileArg = executionCode
    local readerOk, readerProbe = vxPcall(vxLoad, function() return nil end)
    if readerOk and vxTypeOf(readerProbe) == "function" then
        local readPos = 0
        compileArg = function()
            if readPos >= #executionCode then return nil end
            local part = vxSub(executionCode, readPos + 1, readPos + 4096)
            readPos = readPos + 4096
            return part
        end
    end
    local compileOk, scriptChunk, compileError = vxPcall(vxLoad, compileArg)
    if compileOk and not scriptChunk and compileArg ~= executionCode then
        -- Some executors accept chunk functions at probe time but fail on a
        -- real body; retry with the string before giving up.
        compileOk, scriptChunk, compileError = vxPcall(vxLoad, executionCode)
    end
    if (not compileOk or not scriptChunk) and vxLoadAlt and vxLoadAlt ~= vxLoad then
        local altOk, altChunk, altError = vxPcall(vxLoadAlt, executionCode)
        if altOk and altChunk then
            compileOk, scriptChunk = true, altChunk
        elseif not compileError then
            compileError = altError
        end
    end
    if not scriptChunk then
        vxProgress(97, "Compilation failed")
        return error("[VoidedX] " .. tostring(compileError), 0)
    end
    vxProgress(100, "Ready")
    if type(task) == "table" and type(task.synchronize) == "function" then
        vxPcall(task.synchronize)
    end
    return scriptChunk()
end
`.trim();
}
export function buildKeyLoader(id, key, origin, loaderToken, options = {}) {
    const verifyBase = `${origin}/api/verify?id=${encodeURIComponent(id)}${loaderBootQuery(loaderToken, id)}`;
    return packGeneratedLoader(compactGeneratedLoader(`
${robloxOnlyGuard(origin)}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options, id)}

local ok, response = vxFetch(
    "${verifyBase}" ..
    "&key=" .. HttpService:UrlEncode(${luaString(key)}) ..
    vxClientParams(player)
)

if not ok then
    return error("[VoidedX] Could not reach the verification server. Try again.", 0)
end

local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
if not decodeOk or type(result) ~= "table" then
    return error("[VoidedX] Verification server returned a bad response.", 0)
end

if not result.ok then
    if result.code == "vault_removed" then
        ${buildRemovedVaultGui()}
        return
    end
    return error("[VoidedX] " .. tostring(result.message or "Access denied."), 0)
end

return vxRunPayload(result.token, player and player.UserId or nil, result.shield, result.report, result.delivery, result.hop)
`), { id, key, origin, token: loaderToken });
}

export function buildTrackedScript(id, origin, loaderToken, key = '', options = {}) {
    const verifyUrl = `${origin}/api/verify?id=${encodeURIComponent(id)}${loaderBootQuery(loaderToken, id)}`;
    return packGeneratedLoader(compactGeneratedLoader(`
${robloxOnlyGuard(origin)}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options, id)}
local verifyUrl = ${luaString(verifyUrl)} .. vxClientParams(player)

local requestOk, response = vxFetch(verifyUrl)
if not requestOk then
    error("[VoidedX] Could not reach the loader server: " .. tostring(response), 0)
end
local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
if not decodeOk or type(result) ~= "table" then
    error("[VoidedX] Verification server returned a bad response.", 0)
end
if not result.ok then
    if result.code == "vault_removed" then
        ${buildRemovedVaultGui()}
        return
    end
    error("[VoidedX] " .. tostring(result.message or "Could not load the script."), 0)
end
return vxRunPayload(result.token, player and player.UserId or nil, result.shield, result.report, result.delivery, result.hop)
`), { id, key, origin, token: loaderToken });
}
