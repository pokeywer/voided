// VoidedX armor for Prometheus-generated copies.
//
// Prometheus output is recognizable to its own devirtualizers, so the site
// repacks it: the watermark and helper names are removed, the chunk is wrapped
// in a generator function, LZSS-compressed, masked in layers, split into
// shuffled segments, and hidden behind a randomized Lua loader with integrity
// checks. The inner VM settings are unchanged; this module only adds the
// VoidedX container around them.
//
// The container itself is polymorphic: every build picks its own byte mixer
// (add / subtract / affine), its own 32-bit state chain constants, its own
// keystream shift, its own content mix weights, its own LZSS token layout, its
// own buffer sizes, and its own identifier style. Two builds of the same
// script share no constant and no decode shape, so a deobfuscator or a
// pattern-recognizing tool has to be rewritten for each file instead of
// replaying one reusable script.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WINDOW_SIZE = 65536;
const MAX_MATCH = 130;
const NAME_SYLLABLES = Object.freeze([
    'ka', 'zu', 'mo', 're', 'ti', 'vo', 'ne', 'ra', 'sh', 'ul',
    'ix', 'om', 'ep', 'an', 'yi', 'qu', 'da', 'po', 'fi', 'xe'
]);

const LEVEL_CONFIG = Object.freeze({
    fast: { segments: 6, passes: 1, depth: 24, dead: 1, robloxCheck: true, layers: 1 },
    low: { segments: 10, passes: 2, depth: 44, dead: 2, robloxCheck: true, layers: 2 },
    medium: { segments: 14, passes: 4, depth: 60, dead: 3, robloxCheck: true, layers: 3 },
    high: { segments: 18, passes: 4, depth: 72, dead: 4, robloxCheck: true, layers: 3 },
    absolute: { segments: 24, passes: 5, depth: 104, dead: 5, robloxCheck: true, layers: 4 }
});

// Each nested container re-encodes the previous one, so a layer costs roughly
// 1.35x. Stop nesting before large scripts become impossible to store.
const MAX_ARMOR_NEST_CHARS = 420 * 1024;
const MAX_ARMOR_TOTAL_CHARS = 3 * 1024 * 1024;
const MAX_ARMOR_LAYERS = 6;

function createRng() {
    const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
    const buffer = new Uint32Array(1);
    return () => {
        if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
            cryptoObj.getRandomValues(buffer);
            return buffer[0] / 4294967296;
        }
        return Math.random();
    };
}

function randomInt(rng, maxExclusive) {
    return Math.floor(rng() * maxExclusive);
}

// Identifier shapes vary per build. Every component is assigned through this
// factory, so two copies of the same script never share a local name and the
// `_0x` convention that most dumpers key on is only used by some builds.
function createNameFactory(rng) {
    const used = new Set();
    const style = randomInt(rng, 4);
    const emit = {
        0: () => `_0x${randomInt(rng, 0xffffff).toString(16).padStart(6, '0')}`,
        1: () => {
            let name = '';
            const count = 2 + randomInt(rng, 2);
            for (let i = 0; i < count; i++) name += NAME_SYLLABLES[randomInt(rng, NAME_SYLLABLES.length)];
            return `_${name}${randomInt(rng, 100)}`;
        },
        2: () => {
            const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let name = '_';
            const count = 6 + randomInt(rng, 4);
            for (let i = 0; i < count; i++) name += charset[randomInt(rng, charset.length)];
            return name;
        },
        3: () => {
            const consonants = 'bcdfghjklmnpqrstvwxz';
            const vowels = 'aeiou';
            let name = '_';
            const count = 4 + randomInt(rng, 4);
            for (let i = 0; i < count; i++) {
                name += i % 2 === 0
                    ? consonants[randomInt(rng, consonants.length)]
                    : vowels[randomInt(rng, vowels.length)];
            }
            return `${name}${randomInt(rng, 10)}`;
        }
    }[style];
    return () => {
        let name;
        do {
            name = emit();
        } while (used.has(name));
        used.add(name);
        return name;
    };
}

function shuffleAlphabet(rng) {
    const chars = BASE64_ALPHABET.split('');
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        const tmp = chars[i];
        chars[i] = chars[j];
        chars[j] = tmp;
    }
    return chars.join('');
}

function base64Encode(bytes, alphabet) {
    const n = bytes.length;
    const chunks = [];
    let chunk = '';
    for (let i = 0; i < n; i += 3) {
        const has1 = i + 1 < n;
        const has2 = i + 2 < n;
        const b0 = bytes[i];
        const b1 = has1 ? bytes[i + 1] : 0;
        const b2 = has2 ? bytes[i + 2] : 0;
        chunk += alphabet[b0 >> 2];
        chunk += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
        if (has1) chunk += alphabet[((b1 & 15) << 2) | (b2 >> 6)];
        if (has2) chunk += alphabet[b2 & 63];
        if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
    }
    if (chunk) chunks.push(chunk);
    return chunks.join('');
}

function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return b * 65536 + a;
}

function weightedSum(bytes) {
    let total = 0;
    for (let i = 0; i < bytes.length; i++) {
        total = (total + bytes[i] * (i + 1)) % 4294967296;
    }
    return total;
}

// ---------------------------------------------------------------------------
// Polymorphic byte mixer
//
// Each build picks a reversible per-byte operation and a set of 32-bit state
// constants. The state chain advances with the previous ciphertext byte and the
// absolute offset, so the keystream cannot be regenerated without replaying the
// whole stream in order — decoding a single segment in isolation yields noise.
//
// All arithmetic stays below 2^53 so JavaScript doubles and Lua doubles produce
// bit-identical results on LuaJIT, Lua 5.4 and Luau.
// ---------------------------------------------------------------------------
const MASK_CAP = 4294967296;

function maskSpec(rng) {
    const kind = 1 + randomInt(rng, 3);
    const odd = 2 * (1 + randomInt(rng, 127)) + 1;
    let oddInv = 1;
    for (let candidate = 1; candidate < 256; candidate += 2) {
        if ((odd * candidate) % 256 === 1) { oddInv = candidate; break; }
    }
    return {
        kind,
        odd,
        oddInv,
        mul: 104729 + randomInt(rng, 950000),
        inc: randomInt(rng, MASK_CAP),
        shift: 16 + randomInt(rng, 9),
        pMul: 1 + randomInt(rng, 65536),
        qMul: 1 + randomInt(rng, 65536)
    };
}

function maskByte(byte, keyByte, spec) {
    if (spec.kind === 1) return (byte + keyByte) % 256;
    if (spec.kind === 2) return (byte - keyByte + 256) % 256;
    return (spec.odd * byte + keyByte) % 256;
}

function applyMask(bytes, key, spec) {
    const out = new Uint8Array(bytes.length);
    const divisor = 2 ** spec.shift;
    let state = key % MASK_CAP;
    for (let i = 0; i < bytes.length; i++) {
        const keyByte = Math.floor(state / divisor) % 256;
        const code = maskByte(bytes[i], keyByte, spec);
        out[i] = code;
        state = (state * spec.mul + spec.inc + code * spec.pMul + (i + 1) * spec.qMul) % MASK_CAP;
    }
    return out;
}

// The segment order is generated at runtime from a seed, so the delivered file
// never carries a readable permutation table.
function permutationSpec(rng) {
    return {
        seed: randomInt(rng, MASK_CAP),
        mul: 65537 + randomInt(rng, 900000),
        inc: randomInt(rng, MASK_CAP)
    };
}

function buildPermutation(spec, count) {
    const order = [];
    for (let i = 1; i <= count; i++) order.push(i);
    let state = spec.seed % MASK_CAP;
    for (let k = count; k >= 2; k--) {
        state = (state * spec.mul + spec.inc) % MASK_CAP;
        const j = Math.floor((state / MASK_CAP) * k) + 1;
        const tmp = order[k - 1];
        order[k - 1] = order[j - 1];
        order[j - 1] = tmp;
    }
    return order;
}

function splitSegments(bytes, requested) {
    if (bytes.length === 0) return [bytes];
    const count = Math.max(1, Math.min(requested, bytes.length));
    const size = Math.ceil(bytes.length / count);
    const parts = [];
    for (let start = 0; start < bytes.length; start += size) {
        parts.push(bytes.subarray(start, Math.min(bytes.length, start + size)));
    }
    return parts;
}

// Greedy LZSS with a 64 KiB window. The token split point and the minimum match
// length are per-build, so the same script compresses into a different token
// stream on every run:
//   token < splitPoint  -> literal run of token+1 bytes
//   token >= splitPoint -> match length (token - splitPoint + minMatch)
//                          followed by a 16-bit offset
function lzssCompress(bytes, depthLimit, minMatch, splitPoint, layout) {
    const n = bytes.length;
    if (n === 0) return new Uint8Array(0);

    const hashSize = 1 << 16;
    const head = new Int32Array(hashSize).fill(-1);
    const prev = new Int32Array(n).fill(-1);

    let capacity = Math.max(1024, Math.min(n + 64, 1 << 20));
    let out = new Uint8Array(capacity);
    let outLen = 0;

    const ensure = extra => {
        if (outLen + extra <= capacity) return;
        let next = capacity;
        while (next < outLen + extra) next *= 2;
        const grown = new Uint8Array(next);
        grown.set(out.subarray(0, outLen));
        out = grown;
        capacity = next;
    };
    const emit = value => {
        ensure(1);
        out[outLen++] = value;
    };

    const hashAt = pos => ((bytes[pos] << 8) ^ (bytes[pos + 1] << 4) ^ bytes[pos + 2]) & (hashSize - 1);
    const insert = pos => {
        if (pos + 2 >= n) return;
        const hash = hashAt(pos);
        prev[pos] = head[hash];
        head[hash] = pos;
    };

    let i = 0;
    let literalStart = 0;
    const flushLiterals = end => {
        while (literalStart < end) {
            const len = Math.min(splitPoint, end - literalStart);
            emit(len - 1);
            for (let k = 0; k < len; k++) emit(bytes[literalStart + k]);
            literalStart += len;
        }
    };

    while (i < n) {
        let bestLen = 0;
        let bestOffset = 0;

        if (i + 2 < n) {
            const hash = hashAt(i);
            let candidate = head[hash];
            let depth = 0;
            while (candidate >= 0 && depth < depthLimit) {
                const offset = i - candidate;
                if (offset > WINDOW_SIZE - 1) break;
                if (bestLen === 0 || bytes[candidate + bestLen] === bytes[i + bestLen]) {
                    let len = 0;
                    const limit = Math.min(MAX_MATCH, n - i);
                    while (len < limit && bytes[candidate + len] === bytes[i + len]) len++;
                    if (len > bestLen) {
                        bestLen = len;
                        bestOffset = offset;
                        if (len >= limit) break;
                    }
                }
                candidate = prev[candidate];
                depth++;
            }
        }

        if (bestLen >= minMatch) {
            flushLiterals(i);
            emit(splitPoint + (bestLen - minMatch));
            const storedOffset = bestOffset - layout.bias;
            const lowByte = storedOffset & 0xff;
            const highByte = (storedOffset >> 8) & 0xff;
            emit(layout.bigEndian ? highByte : lowByte);
            emit(layout.bigEndian ? lowByte : highByte);
            const end = i + bestLen;
            for (let k = i; k < end; k++) insert(k);
            i = end;
            literalStart = i;
        } else {
            insert(i);
            i++;
        }
    }
    flushLiterals(n);

    return out.slice(0, outLen);
}

function stringToBytes(value) {
    return new TextEncoder().encode(value);
}

function luaString(value) {
    return `"${value}"`;
}

// Copies a Lua chunk, renaming identifier tokens but leaving comments and
// string literals byte-for-byte intact.
function replaceCodeIdentifiers(code, mapping) {
    const names = Object.keys(mapping);
    if (names.length === 0) return code;
    const out = [];
    let i = 0;
    const n = code.length;
    while (i < n) {
        const c = code[i];

        if (c === '[') {
            let eqs = 0;
            let j = i + 1;
            while (j < n && code[j] === '=') { eqs++; j++; }
            if (j < n && code[j] === '[') {
                const close = ']' + '='.repeat(eqs) + ']';
                const end = code.indexOf(close, j + 1);
                if (end !== -1) {
                    out.push(code.slice(i, end + close.length));
                    i = end + close.length;
                    continue;
                }
            }
            out.push(c); i++; continue;
        }

        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                if (code[j] === '\\') { j += 2; continue; }
                if (code[j] === quote) { j++; break; }
                if (code[j] === '\n' || code[j] === '\r') break;
                j++;
            }
            out.push(code.slice(i, j));
            i = j;
            continue;
        }

        if (c === '-' && code[i + 1] === '-') {
            let j = i + 2;
            if (code[j] === '[') {
                let eqs = 0;
                let k = j + 1;
                while (k < n && code[k] === '=') { eqs++; k++; }
                if (k < n && code[k] === '[') {
                    const close = ']' + '='.repeat(eqs) + ']';
                    const end = code.indexOf(close, k + 1);
                    if (end !== -1) {
                        out.push(code.slice(i, end + close.length));
                        i = end + close.length;
                        continue;
                    }
                }
            }
            const newline = code.indexOf('\n', j);
            const end = newline === -1 ? n : newline + 1;
            out.push(code.slice(i, end));
            i = end;
            continue;
        }

        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
            const word = code.slice(i, j);
            out.push(mapping[word] || word);
            i = j;
            continue;
        }

        out.push(c); i++;
    }
    return out.join('');
}

// The generated copy validates its watermark global at startup, so the
// assignment has to stay. Rebuilding the same value from split literals keeps
// the recognizable `("VoidedX:<id>"):gsub(...)` shape out of the file.
function disguiseWatermark(code) {
    return code.replace(
        /\(\s*"VoidedX:([^"]*)"\s*\)\s*:\s*gsub\(\s*"[^"]*"\s*,\s*function\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\2\s*end\s*\)/g,
        (match, id, param, target) => `${target}=("VoidedX:".."${id}")`
    );
}

function buildDeadLua(nextName, rng, count) {
    let out = '';
    for (let i = 0; i < count; i++) {
        const fn = nextName();
        const a = nextName();
        const b = nextName();
        const table = nextName();
        const index = nextName();
        const constant = 200 + randomInt(rng, 57);
        out += `local function ${fn}(${a},${b})\n`;
        out += `    local ${table}={}\n`;
        out += `    local ${index}=1\n`;
        out += `    while ${index}<=4 do\n`;
        out += `        ${table}[${index}]=(${a}*${index}+${b}+${constant})%257\n`;
        out += `        ${index}=${index}+1\n`;
        out += '    end\n';
        out += `    return ${table}\n`;
        out += 'end\n';
    }
    return out;
}

// The engine emits every internal as `<prefix>_<short>` (`eai_C`, `eai_n`, ...).
// That prefix is the cheapest fingerprint a deobfuscator can key on, so the
// dominant prefixed family is redrawn from this build's name factory before the
// chunk is compressed. Redrawing is scope-blind on purpose: the whole family is
// renamed consistently, so locals, upvalues and shadowing keep their bindings.
function collectPrefixedIdentifiers(code) {
    const families = new Map();
    let i = 0;
    const n = code.length;
    while (i < n) {
        const c = code[i];
        if (c === '[') {
            let eqs = 0;
            let j = i + 1;
            while (j < n && code[j] === '=') { eqs++; j++; }
            if (j < n && code[j] === '[') {
                const close = ']' + '='.repeat(eqs) + ']';
                const end = code.indexOf(close, j + 1);
                if (end !== -1) { i = end + close.length; continue; }
            }
            i++; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n) {
                if (code[j] === '\\') { j += 2; continue; }
                if (code[j] === c) { j++; break; }
                if (code[j] === '\n' || code[j] === '\r') break;
                j++;
            }
            i = j; continue;
        }
        if (c === '-' && code[i + 1] === '-') {
            let j = i + 2;
            if (code[j] === '[') {
                let eqs = 0;
                let k = j + 1;
                while (k < n && code[k] === '=') { eqs++; k++; }
                if (k < n && code[k] === '[') {
                    const close = ']' + '='.repeat(eqs) + ']';
                    const end = code.indexOf(close, k + 1);
                    if (end !== -1) { i = end + close.length; continue; }
                }
            }
            const newline = code.indexOf('\n', j);
            i = newline === -1 ? n : newline + 1;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
            const word = code.slice(i, j);
            const field = i > 0 && (code[i - 1] === '.' || code[i - 1] === ':');
            if (!field) {
                const match = /^([A-Za-z][A-Za-z0-9]*)_[A-Za-z0-9_]+$/.exec(word);
                if (match) {
                    const family = families.get(match[1]) || new Set();
                    family.add(word);
                    families.set(match[1], family);
                }
            }
            i = j; continue;
        }
        i++;
    }
    return families;
}

function scrubPrometheusNames(code, nextName) {
    let best = null;
    for (const names of collectPrefixedIdentifiers(code).values()) {
        if (names.size < 12) continue;
        if (!best || names.size > best.size) best = names;
    }
    if (!best) return code;
    const mapping = {};
    for (const name of best) mapping[name] = nextName();
    return replaceCodeIdentifiers(code, mapping);
}

function prepareInner(source, rng, nextName, deadCount) {
    let inner = disguiseWatermark(source);
    inner = scrubPrometheusNames(inner, nextName);

    const shimName = nextName();
    const lenName = nextName();
    const typeName = nextName();
    const pcallName = nextName();
    const lenFnName = nextName();
    inner = replaceCodeIdentifiers(inner, {
        __vxL: shimName,
        _sl: lenName,
        _tp: typeName,
        _pc: pcallName,
        _ln: lenFnName
    });

    const chunkName = nextName();
    const dead = buildDeadLua(nextName, rng, Math.max(1, deadCount));
    const wrapperCheck = nextName();
    const opaqueA = 17 + randomInt(rng, 240);
    const opaqueB = 19 + randomInt(rng, 240);
    const opaqueC = 7 + randomInt(rng, 500);
    const opaqueM = 31 + randomInt(rng, 60);
    const opaqueExpected = (opaqueA * opaqueB + opaqueC) % opaqueM;
    let secondGuard = '';
    if (deadCount >= 3) {
        const check2 = nextName();
        const a2 = 13 + randomInt(rng, 220);
        const b2 = 11 + randomInt(rng, 210);
        const c2 = 5 + randomInt(rng, 640);
        const m2 = 41 + randomInt(rng, 70);
        secondGuard = `local ${check2}=(${a2}*${b2}+${c2})%${m2}\n`
            + `if ${check2}~=${(a2 * b2 + c2) % m2} then return end\n`;
    }
    const guarded = `local function ${chunkName}(...)\n`
        + dead
        + `local ${wrapperCheck}=(${opaqueA}*${opaqueB}+${opaqueC})%${opaqueM}\n`
        + `if ${wrapperCheck}~=${opaqueExpected} then return end\n`
        + secondGuard
        + inner
        + `\nend\nreturn ${chunkName}(...)\n`;
    return guarded;
}

function numericExpr(value, rng) {
    if (value < 0 || value > 4294967295) return String(value);
    const style = randomInt(rng, 3);
    if (style === 0) {
        const high = Math.floor(value / 65536);
        const low = value % 65536;
        return `(${high}*65536+${low})`;
    }
    if (style === 1 && value >= 1000000) {
        const base = 1000000 + randomInt(rng, 500000);
        return `(${value - base}+${base})`;
    }
    return String(value);
}

// Masked message bytes, spelled as small arithmetic expressions. Error text is
// only rebuilt when a check fails, so the delivered file never carries the
// loader's messages as readable strings.
function maskedMessageTable(text, key, rng) {
    const bytes = stringToBytes(text);
    const parts = [];
    for (const byte of bytes) {
        const masked = (byte + key) % 256;
        const offset = 1 + randomInt(rng, 90);
        parts.push(rng() < 0.5 && masked >= offset ? `(${masked - offset}+${offset})` : String(masked));
    }
    return `{${parts.join(',')}}`;
}

function splitAlphabetLiteral(alphabet, rng) {
    const cuts = [0];
    const first = 12 + randomInt(rng, 20);
    const second = 36 + randomInt(rng, 16);
    cuts.push(first, second, alphabet.length);
    const parts = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        parts.push(luaString(alphabet.slice(cuts[i], cuts[i + 1])));
    }
    return parts.join('..');
}

// Token-level reflow: drops comments, then scatters line breaks and padding so
// the delivered file reads like raw VM output instead of a formatted script.
// Strings and long brackets are copied verbatim, and a gap is forced only where
// removing it would merge two tokens (e.g. `end local`, `a-b` / `--`).
function needsTokenGap(prev, next) {
    const a = prev[prev.length - 1];
    const b = next[0];
    if (/[A-Za-z0-9_]/.test(a) && /[A-Za-z0-9_]/.test(b)) return true;
    if (a === '-' && b === '-') return true;
    if (/[0-9]/.test(a) && b === '.') return true;
    if (a === '[' && (b === '[' || b === '=')) return true;
    return false;
}

function messifyLua(code, rng, layout = 'messy') {
    const compact = layout === 'compact';
    const tokens = [];
    const n = code.length;
    let i = 0;

    while (i < n) {
        const c = code[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i += 1; continue; }

        if (c === '-' && code[i + 1] === '-') {
            let j = i + 2;
            if (code[j] === '[') {
                let eqs = 0;
                let k = j + 1;
                while (k < n && code[k] === '=') { eqs += 1; k += 1; }
                if (k < n && code[k] === '[') {
                    const close = ']' + '='.repeat(eqs) + ']';
                    const end = code.indexOf(close, k + 1);
                    i = end === -1 ? n : end + close.length;
                    continue;
                }
            }
            const newline = code.indexOf('\n', j);
            i = newline === -1 ? n : newline + 1;
            continue;
        }

        if (c === '[') {
            let eqs = 0;
            let k = i + 1;
            while (k < n && code[k] === '=') { eqs += 1; k += 1; }
            if (k < n && code[k] === '[') {
                const close = ']' + '='.repeat(eqs) + ']';
                const end = code.indexOf(close, k + 1);
                if (end !== -1) {
                    tokens.push(code.slice(i, end + close.length));
                    i = end + close.length;
                    continue;
                }
            }
            tokens.push(c);
            i += 1;
            continue;
        }

        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n) {
                if (code[j] === '\\') { j += 2; continue; }
                if (code[j] === c) { j += 1; break; }
                j += 1;
            }
            tokens.push(code.slice(i, j));
            i = j;
            continue;
        }

        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(code[j])) j += 1;
            tokens.push(code.slice(i, j));
            i = j;
            continue;
        }

        if (/[0-9]/.test(c)) {
            let j = i + 1;
            while (j < n && /[0-9]/.test(code[j])) j += 1;
            if (code[j] === '.' && /[0-9]/.test(code[j + 1] || '')) {
                j += 1;
                while (j < n && /[0-9]/.test(code[j])) j += 1;
            }
            tokens.push(code.slice(i, j));
            i = j;
            continue;
        }

        // Multi-character operators must stay whole: splitting `~=` or `<=`
        // across a line break produces a parse error, not just ugly code.
        if (code.startsWith('...', i)) {
            tokens.push('...');
            i += 3;
            continue;
        }
        const pair = code.slice(i, i + 2);
        if (pair === '..' || pair === '==' || pair === '~=' || pair === '<=' || pair === '>=' || pair === '//' || pair === '::') {
            tokens.push(pair);
            i += 2;
            continue;
        }

        tokens.push(c);
        i += 1;
    }

    let out = '-- VoidedX\n';
    let sinceBreak = 0;
    for (let t = 0; t < tokens.length; t += 1) {
        const token = tokens[t];
        const prev = tokens[t - 1];
        if (t > 0) {
            const gap = needsTokenGap(prev, token) ? ' ' : (compact ? '' : (rng() < 0.18 ? ' ' : ''));
            out += gap;
        }
        out += token;
        sinceBreak += 1;
        // A break before `(`/`{`/`[` turns the following statement into a
        // continuation call or index, which Luau rejects as ambiguous syntax.
        const breakSafe = token !== '(' && token !== '{' && token !== '['
            && tokens[t + 1] !== '(' && tokens[t + 1] !== '{' && tokens[t + 1] !== '['
            && prev !== 'return';
        const shouldBreak = compact
            ? sinceBreak > 200
            : sinceBreak > 30 && (rng() < 0.14 || sinceBreak > 240);
        if (breakSafe && shouldBreak) {
            out += !compact && rng() < 0.02 ? '\n\n' : '\n';
            sinceBreak = 0;
        }
    }
    return out + '\n';
}

function buildLoader(o) {
    const p = o.names;
    const rng = o.rng;
    const nextName = p.nextName;
    // Every local inside the emitted loader is drawn from a fresh factory, so
    // no two builds share an identifier even when the generated bodies match.
    const locals = keys => {
        const out = {};
        for (const key of keys) out[key] = nextName();
        return out;
    };
    const lines = [];
    const add = line => lines.push(line);
    const spec = o.mask;
    const layout = o.lz;
    const shiftDivisor = 2 ** spec.shift;
    // Inert arithmetic padding. The result is always non-negative, so the
    // branch is unreachable; it exists only to make each helper body differ
    // from build to build.
    const decoy = () => {
        const a = 3 + randomInt(rng, 400);
        const b = 5 + randomInt(rng, 300);
        const c = 7 + randomInt(rng, 900);
        const m = 29 + randomInt(rng, 200);
        const name = nextName();
        return [
            `    local ${name}=(${a}*${b}+${c})%${m}`,
            `    if ${name}<0 then return nil end`
        ];
    };

    add(`local ${p.sbyte},${p.schar},${p.ssub},${p.slen}=string.byte,string.char,string.sub,string.len`);
    add(`local ${p.sconcat}=table.concat`);
    add(`local ${p.sunpack}=table.unpack or unpack`);
    add(`local ${p.floor}=math.floor`);
    add(`local ${p.type}=type`);
    add(`local ${p.pcall}=pcall`);
    add(`local ${p.rawequal}=rawequal`);
    add(`local ${p.error}=error`);
    add(`local ${p.debug}=debug`);
    add(`local ${p.gethook}=${p.debug} and ${p.debug}.gethook or nil`);
    add(`local ${p.sethook}=${p.debug} and ${p.debug}.sethook or nil`);
    add(`local ${p.getgenv}=type(getgenv)=="function" and getgenv or nil`);
    add(`local ${p.info}=nil`);
    add(`do local ${p.infoAlt}=${p.debug} if ${p.infoAlt} then ${p.info}=${p.infoAlt}.info or ${p.infoAlt}.getinfo end end`);

    // A loader is only trusted while it is still the engine's own C function.
    // Every dump starts with hookfunction(loadstring) or hookfunction(load),
    // which swaps the C function for a Lua closure that records the chunk it is
    // handed. debug.info/debug.getinfo reports "C" for the untouched builtin and
    // the wrapper's script source for a hooked one, so a replacement is caught
    // before any payload is compiled through it.
    const nv = locals(['fn', 'ok', 'd', 'what', 'ok2', 's']);
    add(`local ${p.native}=function(${nv.fn})`);
    add(`    if ${p.type}(${nv.fn})~="function" then return false end`);
    add(`    if not ${p.info} then return true end`);
    add(`    local ${nv.ok},${nv.d}=${p.pcall}(${p.info},${nv.fn},"S")`);
    add(`    if ${nv.ok} and ${p.type}(${nv.d})=="table" then`);
    add(`        local ${nv.what}=${nv.d}.what`);
    add(`        if ${nv.what}=="C" or ${nv.what}==nil then return true end`);
    add(`        return false`);
    add(`    end`);
    add(`    local ${nv.ok2},${nv.s}=${p.pcall}(${p.info},${nv.fn},"s")`);
    add(`    if ${nv.ok2} and ${p.type}(${nv.s})=="string" then return ${nv.s}=="[C]" end`);
    add(`    return true`);
    add(`end`);

    // Loaders from every environment the executor exposes: a dumper often hooks
    // the executor global_env but leaves getrenv()/_G pristine, so the first
    // native candidate wins over anything that has been wrapped.
    const cd = locals(['list', 'add', 'count', 'i', 'f', 'envs', 'ec', 'e', 'ok', 'v']);
    add(`local ${cd.list},${cd.count}={},0`);
    add(`local ${cd.add}=function(${cd.v})`);
    add(`    if ${p.type}(${cd.v})~="function" then return end`);
    add(`    local ${cd.i}=1`);
    add(`    while ${cd.i}<=${cd.count} do if ${cd.list}[${cd.i}]==${cd.v} then return end ${cd.i}=${cd.i}+1 end`);
    add(`    ${cd.count}=${cd.count}+1 ${cd.list}[${cd.count}]=${cd.v}`);
    add(`end`);
    add(`${cd.add}(loadstring) ${cd.add}(load)`);
    add(`if ${p.type}(_G)=="table" then ${cd.add}(_G.loadstring) ${cd.add}(_G.load) end`);
    add(`do local ${cd.envs},${cd.ec}={},0`);
    add(`    if ${p.type}(getfenv)=="function" then local ${cd.ok},${cd.e}=${p.pcall}(getfenv,0) if ${cd.ok} and ${p.type}(${cd.e})=="table" then ${cd.ec}=${cd.ec}+1 ${cd.envs}[${cd.ec}]=${cd.e} end end`);
    add(`    if ${p.type}(getgenv)=="function" then local ${cd.ok},${cd.e}=${p.pcall}(getgenv) if ${cd.ok} and ${p.type}(${cd.e})=="table" then ${cd.ec}=${cd.ec}+1 ${cd.envs}[${cd.ec}]=${cd.e} end end`);
    add(`    if ${p.type}(getrenv)=="function" then local ${cd.ok},${cd.e}=${p.pcall}(getrenv) if ${cd.ok} and ${p.type}(${cd.e})=="table" then ${cd.ec}=${cd.ec}+1 ${cd.envs}[${cd.ec}]=${cd.e} end end`);
    add(`    local ${cd.i}=1`);
    add(`    while ${cd.i}<=${cd.ec} do local ${cd.e}=${cd.envs}[${cd.i}] ${cd.add}(${cd.e}.loadstring) ${cd.add}(${cd.e}.load) ${cd.i}=${cd.i}+1 end`);
    add(`end`);
    add(`local ${p.load}=nil`);
    add(`do local ${cd.i}=1 while ${cd.i}<=${cd.count} do local ${cd.f}=${cd.list}[${cd.i}] if ${p.native}(${cd.f}) then ${p.load}=${cd.f} break end ${cd.i}=${cd.i}+1 end end`);
    const msgL = locals(['t', 'k', 'o', 'i']);
    add(`local ${p.msg}=function(${msgL.t},${msgL.k}) local ${msgL.o}="" for ${msgL.i}=1,#${msgL.t} do ${msgL.o}=${msgL.o}..${p.schar}((${msgL.t}[${msgL.i}]-${msgL.k})%256) end return ${p.error}(${msgL.o},0) end`);
    add(`if not ${p.load} then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`if not ${p.sconcat} or not ${p.sunpack} then return ${p.msg}(${o.messages.executor.table},${o.messages.executor.key}) end`);
    add('');

    // A hook is how a dumper watches a chunk being built. The bootstrap's
    // watchdog is the only acceptable one, and it is removed for the decode and
    // compile and put back before the payload runs, so a copy that satisfies the
    // getgenv()._vxwd marker with its own hook still sees nothing.
    const hk = locals(['ok', 'hook', 'mask', 'count', 'expected', 'envOk', 'env', 'sok', 'vok', 'still']);
    add(`local ${p.restore}={}`);
    add(`do`);
    add(`    if ${p.gethook} then`);
    add(`        local ${hk.ok},${hk.hook},${hk.mask},${hk.count}=${p.pcall}(${p.gethook})`);
    add(`        if ${hk.ok} and ${hk.hook}~=nil then`);
    add(`            local ${hk.expected}=nil`);
    add(`            if ${p.getgenv} then local ${hk.envOk},${hk.env}=${p.pcall}(${p.getgenv}) if ${hk.envOk} and ${p.type}(${hk.env})=="table" then ${hk.expected}=${hk.env}._vxwd end end`);
    add(`            if ${hk.expected}~=${hk.hook} or not ${p.sethook} or not ${p.native}(${p.sethook}) then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`            local ${hk.sok}=${p.pcall}(${p.sethook})`);
    add(`            local ${hk.vok},${hk.still}=${p.pcall}(${p.gethook})`);
    add(`            if not ${hk.sok} or not ${hk.vok} or ${hk.still}~=nil then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`            ${p.restore}[1],${p.restore}[2],${p.restore}[3]=${hk.hook},${hk.mask},${hk.count}`);
    add(`        end`);
    add(`    end`);
    add(`end`);

    add(buildDeadLua(nextName, rng, o.dead));
    add('');

    const ck = locals(['ok', 'hook']);
    add(`local ${p.check}=function()`);
    add(`    if string.byte~=${p.sbyte} or string.char~=${p.schar} or string.sub~=${p.ssub} or string.len~=${p.slen} then return false end`);
    add(`    if table.concat~=${p.sconcat} then return false end`);
    add(`    if rawequal~=${p.rawequal} then return false end`);
    add(`    if not ${p.native}(${p.pcall}) or not ${p.native}(${p.error}) or not ${p.native}(${p.rawequal}) or not ${p.native}(${p.load}) then return false end`);
    // Decoding primitives are checked too: hooking table.concat or string.char
    // captures the decoded chunk just as easily as hooking the loader itself.
    add(`    if not ${p.native}(${p.sbyte}) or not ${p.native}(${p.schar}) or not ${p.native}(${p.ssub}) or not ${p.native}(${p.slen}) then return false end`);
    add(`    if not ${p.native}(${p.sconcat}) or not ${p.native}(${p.sunpack}) or not ${p.native}(${p.floor}) then return false end`);
    add(`    if ${p.pcall}(${p.error}) then return false end`);
    // The hook is cleared before decoding, so anything visible here was
    // installed after that point.
    add(`    if ${p.gethook} then`);
    add(`        local ${ck.ok},${ck.hook}=${p.pcall}(${p.gethook})`);
    add(`        if not ${ck.ok} or ${ck.hook}~=nil then return false end`);
    add(`    end`);
    add(`    return true`);
    add(`end`);
    add('');

    if (o.robloxCheck) {
        const rb = locals(['players']);
        add(`local ${p.probe}=${p.pcall}(function()`);
        add(`    local ${rb.players}=game:GetService("Players")`);
        add(`    return ${rb.players}~=nil`);
        add(`end)`);
        add(`if not ${p.probe} then return ${p.msg}(${o.messages.roblox.table},${o.messages.roblox.key}) end`);
        add('');
    }

    const mapL = locals(['i']);
    add(`local ${p.alpha}=${splitAlphabetLiteral(o.alphabet, o.rng)}`);
    add(`local ${p.map}={}`);
    add(`do local ${mapL.i}=1 while ${mapL.i}<=64 do ${p.map}[${p.sbyte}(${p.alpha},${mapL.i})]=${mapL.i}-1 ${mapL.i}=${mapL.i}+1 end end`);
    add('');

    const b = locals(['s', 'n', 'out', 'on', 'buf', 'bn', 'i', 'c1', 'c2', 'c3', 'c4', 'v']);
    add(`local ${p.b64}=function(${b.s})`);
    add(`    local ${b.n}=${p.slen}(${b.s})`);
    add(`    local ${b.out}={}`);
    add(`    local ${b.on}=0`);
    add(`    local ${b.buf}={}`);
    add(`    local ${b.bn}=0`);
    add(`    local ${b.i}=1`);
    decoy().forEach(line => add(line));
    add(`    while ${b.i}<=${b.n} do`);
    add(`        local ${b.c1}=${p.map}[${p.sbyte}(${b.s},${b.i})] or 0`);
    add(`        local ${b.c2}=${p.map}[${p.sbyte}(${b.s},${b.i}+1)] or 0`);
    add(`        local ${b.c3}=${p.map}[${p.sbyte}(${b.s},${b.i}+2)] or 0`);
    add(`        local ${b.c4}=${p.map}[${p.sbyte}(${b.s},${b.i}+3)] or 0`);
    add(`        local ${b.v}=${b.c1}*262144+${b.c2}*4096+${b.c3}*64+${b.c4}`);
    add(`        ${b.bn}=${b.bn}+1 ${b.buf}[${b.bn}]=${p.floor}(${b.v}/65536)%256`);
    add(`        if ${b.i}+2<=${b.n} then ${b.bn}=${b.bn}+1 ${b.buf}[${b.bn}]=${p.floor}(${b.v}/256)%256 end`);
    add(`        if ${b.i}+3<=${b.n} then ${b.bn}=${b.bn}+1 ${b.buf}[${b.bn}]=${b.v}%256 end`);
    add(`        if ${b.bn}>=${o.flush.b64} then ${b.on}=${b.on}+1 ${b.out}[${b.on}]=${p.schar}(${p.sunpack}(${b.buf},1,${b.bn})) ${b.buf}={} ${b.bn}=0 end`);
    add(`        ${b.i}=${b.i}+4`);
    add(`    end`);
    add(`    if ${b.bn}>0 then ${b.on}=${b.on}+1 ${b.out}[${b.on}]=${p.schar}(${p.sunpack}(${b.buf},1,${b.bn})) end`);
    add(`    return ${p.sconcat}(${b.out})`);
    add(`end`);
    add('');

    const u = locals(['s', 'key', 'n', 'out', 'on', 'buf', 'bn', 'st', 'i', 'ch', 'k']);
    const decodeExpr = spec.kind === 1
        ? `(${u.ch}-${u.k})%256`
        : spec.kind === 2
            ? `(${u.ch}+${u.k})%256`
            : `((${u.ch}-${u.k})*${spec.oddInv})%256`;
    add(`local ${p.unmask}=function(${u.s},${u.key})`);
    add(`    local ${u.n}=${p.slen}(${u.s})`);
    add(`    local ${u.out}={}`);
    add(`    local ${u.on}=0`);
    add(`    local ${u.buf}={}`);
    add(`    local ${u.bn}=0`);
    add(`    local ${u.st}=${u.key}%4294967296`);
    add(`    local ${u.i}=1`);
    decoy().forEach(line => add(line));
    add(`    while ${u.i}<=${u.n} do`);
    add(`        local ${u.ch}=${p.sbyte}(${u.s},${u.i})`);
    add(`        local ${u.k}=${p.floor}(${u.st}/${shiftDivisor})%256`);
    add(`        ${u.bn}=${u.bn}+1 ${u.buf}[${u.bn}]=${decodeExpr}`);
    add(`        ${u.st}=(${u.st}*${spec.mul}+${spec.inc}+${u.ch}*${spec.pMul}+${u.i}*${spec.qMul})%4294967296`);
    add(`        if ${u.bn}>=${o.flush.unmask} then ${u.on}=${u.on}+1 ${u.out}[${u.on}]=${p.schar}(${p.sunpack}(${u.buf},1,${u.bn})) ${u.buf}={} ${u.bn}=0 end`);
    add(`        ${u.i}=${u.i}+1`);
    add(`    end`);
    add(`    if ${u.bn}>0 then ${u.on}=${u.on}+1 ${u.out}[${u.on}]=${p.schar}(${p.sunpack}(${u.buf},1,${u.bn})) end`);
    add(`    return ${p.sconcat}(${u.out})`);
    add(`end`);
    add('');

    // The chunk is never assembled. This inflater is a pull iterator: it keeps
    // the window and the token position, emits at most one piece per call, and
    // resumes mid-run when a literal run or a match copy crosses a piece edge,
    // so the plaintext source exists only as the piece `load` is parsing.
    const f = locals(['s', 'n', 'win', 'wpos', 'produced', 'buf', 'bn', 'i', 'c', 'stop', 'v', 'len', 'b1', 'b2', 'off', 'j', 'litLeft']);
    // b1/b2 are the two offset bytes in stream order; the expression turns them
    // back into a distance using this build's byte order and bias.
    const offsetExpr = (layout.bigEndian ? `${f.b1}*256+${f.b2}` : `${f.b2}*256+${f.b1}`)
        + (layout.bias ? `+${layout.bias}` : '');
    add(`local ${p.inflate}=function(${f.s})`);
    add(`    local ${f.n}=${p.slen}(${f.s})`);
    add(`    local ${f.win}={}`);
    add(`    local ${f.wpos}=0`);
    add(`    local ${f.produced}=0`);
    add(`    local ${f.buf}={}`);
    add(`    local ${f.bn}=0`);
    add(`    local ${f.i}=1`);
    add(`    local ${f.stop}=0`);
    add(`    local ${f.j}=0`);
    add(`    local ${f.off}=0`);
    decoy().forEach(line => add(line));
    add(`    return function()`);
    add(`        ${f.buf}={} ${f.bn}=0`);
    add(`        while true do`);
    add(`            if ${f.j}>0 then`);
    add(`                local ${f.v}=${f.win}[(${f.wpos}-${f.off})%65536]`);
    add(`                if ${f.v}==nil then return nil end`);
    add(`                ${f.bn}=${f.bn}+1 ${f.buf}[${f.bn}]=${f.v}`);
    add(`                ${f.win}[${f.wpos}]=${f.v}`);
    add(`                ${f.wpos}=${f.wpos}+1`);
    add(`                if ${f.wpos}==65536 then ${f.wpos}=0 end`);
    add(`                ${f.produced}=${f.produced}+1`);
    add(`                ${f.j}=${f.j}-1`);
    add(`                if ${f.bn}>=${o.readPiece} then return ${p.schar}(${p.sunpack}(${f.buf},1,${f.bn})) end`);
    add(`            elseif ${f.stop}>0 then`);
    add(`                if ${f.i}>=${f.stop} then ${f.stop}=0 else`);
    add(`                    local ${f.v}=${p.sbyte}(${f.s},${f.i})`);
    add(`                    ${f.i}=${f.i}+1`);
    add(`                    ${f.bn}=${f.bn}+1 ${f.buf}[${f.bn}]=${f.v}`);
    add(`                    ${f.win}[${f.wpos}]=${f.v}`);
    add(`                    ${f.wpos}=${f.wpos}+1`);
    add(`                    if ${f.wpos}==65536 then ${f.wpos}=0 end`);
    add(`                    ${f.produced}=${f.produced}+1`);
    add(`                    if ${f.bn}>=${o.readPiece} then return ${p.schar}(${p.sunpack}(${f.buf},1,${f.bn})) end`);
    add(`                end`);
    add(`            elseif ${f.i}<=${f.n} then`);
    add(`                local ${f.c}=${p.sbyte}(${f.s},${f.i})`);
    add(`                ${f.i}=${f.i}+1`);
    add(`                if ${f.c}<${layout.splitPoint} then`);
    add(`                    ${f.stop}=${f.i}+${f.c}+1`);
    add(`                else`);
    add(`                    ${f.j}=${f.c}-${layout.splitPoint - layout.minMatch}`);
    add(`                    local ${f.b1}=${p.sbyte}(${f.s},${f.i}) or 0`);
    add(`                    local ${f.b2}=${p.sbyte}(${f.s},${f.i}+1) or 0`);
    add(`                    ${f.i}=${f.i}+2`);
    add(`                    ${f.off}=${offsetExpr}`);
    add(`                    if ${f.off}<1 or ${f.off}>${f.produced} then return nil end`);
    add(`                end`);
    add(`            elseif ${f.bn}>0 then`);
    add(`                return ${p.schar}(${p.sunpack}(${f.buf},1,${f.bn}))`);
    add(`            else`);
    add(`                return nil`);
    add(`            end`);
    add(`        end`);
    add(`    end`);
    add(`end`);
    add('');

    const ad = locals(['s', 'n', 'a', 'b', 'i']);
    add(`local ${p.adler}=function(${ad.s})`);
    add(`    local ${ad.n}=${p.slen}(${ad.s})`);
    add(`    local ${ad.a}=1`);
    add(`    local ${ad.b}=0`);
    add(`    local ${ad.i}=1`);
    decoy().forEach(line => add(line));
    add(`    while ${ad.i}<=${ad.n} do`);
    add(`        ${ad.a}=(${ad.a}+${p.sbyte}(${ad.s},${ad.i}))%65521`);
    add(`        ${ad.b}=(${ad.b}+${ad.a})%65521`);
    add(`        ${ad.i}=${ad.i}+1`);
    add(`    end`);
    add(`    return ${ad.b}*65536+${ad.a}`);
    add(`end`);
    add('');

    const sm = locals(['s', 'n', 't', 'i']);
    add(`local ${p.sum2}=function(${sm.s})`);
    add(`    local ${sm.n}=${p.slen}(${sm.s})`);
    add(`    local ${sm.t}=0`);
    add(`    local ${sm.i}=1`);
    decoy().forEach(line => add(line));
    add(`    while ${sm.i}<=${sm.n} do`);
    add(`        ${sm.t}=(${sm.t}+${p.sbyte}(${sm.s},${sm.i})*${sm.i})%4294967296`);
    add(`        ${sm.i}=${sm.i}+1`);
    add(`    end`);
    add(`    return ${sm.t}`);
    add(`end`);
    add('');

    add(`local ${p.segs}={`);
    for (const segment of o.segments) add(`    ${luaString(segment.b64)},`);
    add('}');
    add(`local ${p.keys}={${o.segments.map(segment => numericExpr(segment.key, o.rng)).join(',')}}`);
    add(`local ${p.passKeys}={${o.passKeys.map(key => numericExpr(key, o.rng)).join(',')}}`);
    add(`local ${p.compLen}=${numericExpr(o.compressedLength, o.rng)}`);
    add(`local ${p.sum1}=${numericExpr(o.checksum1, o.rng)}`);
    add(`local ${p.sum3}=${numericExpr(o.checksum2, o.rng)}`);
    add('');

    // Segment order is rebuilt at runtime from a seed, so the file carries no
    // readable permutation table and the seed alone is useless without the
    // matching step constants.
    const ord = locals(['k', 'st', 'j']);
    add(`local ${p.order}={}`);
    add(`do`);
    add(`    local ${ord.k}=1`);
    add(`    while ${ord.k}<=${o.segments.length} do ${p.order}[${ord.k}]=${ord.k} ${ord.k}=${ord.k}+1 end`);
    add(`    local ${ord.st}=${numericExpr(o.order.seed, o.rng)}%4294967296`);
    add(`    for ${ord.k}=${o.segments.length},2,-1 do`);
    add(`        ${ord.st}=(${ord.st}*${numericExpr(o.order.mul, o.rng)}+${numericExpr(o.order.inc, o.rng)})%4294967296`);
    add(`        local ${ord.j}=${p.floor}(${ord.st}/4294967296*${ord.k})+1`);
    add(`        ${p.order}[${ord.k}],${p.order}[${ord.j}]=${p.order}[${ord.j}],${p.order}[${ord.k}]`);
    add(`    end`);
    add(`end`);
    add('');

    const d = locals(['parts', 'i', 'data', 'k']);
    add(`local ${p.decode}=function()`);
    add(`    local ${d.parts}={}`);
    add(`    local ${d.i}=1`);
    add(`    while ${d.i}<=${o.segments.length} do`);
    add(`        ${d.parts}[${p.order}[${d.i}]]=${p.unmask}(${p.b64}(${p.segs}[${d.i}]),${p.keys}[${d.i}])`);
    add(`        ${d.i}=${d.i}+1`);
    add(`    end`);
    add(`    local ${d.data}=${p.sconcat}(${d.parts})`);
    add(`    ${d.parts}=nil`);
    add(`    local ${d.k}=${o.passKeys.length}`);
    add(`    while ${d.k}>=1 do ${d.data}=${p.unmask}(${d.data},${p.passKeys}[${d.k}]) ${d.k}=${d.k}-1 end`);
    add(`    if ${p.slen}(${d.data})~=${p.compLen} then return nil end`);
    add(`    if ${p.adler}(${d.data})~=${p.sum1} then return nil end`);
    add(`    if ${p.sum2}(${d.data})~=${p.sum3} then return nil end`);
    add(`    return ${d.data}`);
    add(`end`);
    add('');

    add(`if (${o.opaqueA}*${o.opaqueB}+${o.opaqueC})%${o.opaqueM}~=${o.opaqueExpected} then return end`);
    add(`if not ${p.check}() then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`local ${p.src}=${p.decode}()`);
    add(`if not ${p.src} then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`local ${p.okProbe},${p.probeFn}=${p.pcall}(${p.load},function() return nil end)`);
    add(`if not ${p.okProbe} or ${p.type}(${p.probeFn})~="function" then return ${p.msg}(${o.messages.executor.table},${o.messages.executor.key}) end`);
    add(`local ${p.arg}=${p.inflate}(${p.src})`);
    add(`if not ${p.check}() then return ${p.msg}(${o.messages.start.table},${o.messages.start.key}) end`);
    add(`local ${p.fn},${p.err}=${p.load}(${p.arg},"=${o.chunkName}")`);
    add(`if not ${p.fn} then`);
    add(`    return ${p.msg}(${o.messages.start.table},${o.messages.start.key})`);
    add(`end`);
    add(`if ${p.restore}[1]~=nil then ${p.pcall}(${p.sethook},${p.restore}[1],${p.restore}[2],${p.restore}[3]) end`);
    add(`return ${p.fn}()`);

    return lines.join('\n');
}

// Five-row block letters keep the banner aligned without multi-byte glyphs, so
// it survives every executor's source viewer and never terminates the long
// comment it lives in.
const BANNER_FONT = {
    V: ['##   ##', '##   ##', '##   ##', ' ## ## ', '  ###  '],
    O: [' ##### ', '##   ##', '##   ##', '##   ##', ' ##### '],
    I: ['######', '  ##  ', '  ##  ', '  ##  ', '######'],
    D: ['##### ', '##  ##', '##  ##', '##  ##', '##### '],
    E: ['######', '##    ', '####  ', '##    ', '######'],
    X: ['##   ##', ' ## ## ', '  ###  ', ' ## ## ', '##   ##'],
    ' ': ['  ', '  ', '  ', '  ', '  ']
};

function renderBannerWord(word) {
    const rows = ['', '', '', '', ''];
    for (const letter of word) {
        const glyph = BANNER_FONT[letter] || BANNER_FONT[' '];
        for (let row = 0; row < 5; row += 1) rows[row] += glyph[row] + ' ';
    }
    return rows;
}

function buildBanner() {
    const art = renderBannerWord('VOIDEDX');
    return [
        '--[[',
        '   ' + art[0],
        '   ' + art[1],
        '   ' + art[2],
        '   ' + art[3],
        '   ' + art[4],
        '',
        '   VOIDEDX OBFUSCATION   //   voidedx.vercel.app',
        '   do not resell   |   all rights reserved',
        ']]'
    ].join('\n');
}

// Identifiers built only from the characters that collide in most monospace
// fonts (l/I/1, O/0/o, S/5, Z/2, B/8, G/6, q/9), so the preamble reads as noise
// in a dump. A letter always starts the name, so every result is a legal Lua
// identifier, and the factory never repeats one within a single build.
const CONFUSABLE_HEADS = 'lIBDGgqOQSZ';
const CONFUSABLE_TAILS = 'lI1O0oQ5S2Z8B6G9qg';

function createConfusableFactory(rng) {
    const used = new Set();
    return () => {
        for (;;) {
            let name = CONFUSABLE_HEADS[randomInt(rng, CONFUSABLE_HEADS.length)];
            const length = 5 + randomInt(rng, 8);
            for (let i = 0; i < length; i += 1) {
                name += CONFUSABLE_TAILS[randomInt(rng, CONFUSABLE_TAILS.length)];
            }
            if (used.has(name)) continue;
            used.add(name);
            return name;
        }
    };
}

function noiseComment(rng) {
    const glyphs = CONFUSABLE_TAILS;
    const parts = [];
    for (let word = 2 + randomInt(rng, 4); word > 0; word -= 1) {
        let text = '';
        for (let i = 3 + randomInt(rng, 8); i > 0; i -= 1) {
            text += glyphs[randomInt(rng, glyphs.length)];
        }
        parts.push(text);
    }
    return parts.join(' ');
}

// Decorative statements only: every block is self-contained, touches nothing but
// its own `do ... end` locals, and leaves no globals behind. Two portability
// rules hold for every shape: no empty statement (LuaJIT rejects `;;`) and no
// bare-variable table keys (those would read a global instead of a name).
function buildJunkCode(rng, count, options = {}) {
    const comments = options.comments !== false;
    const next = createConfusableFactory(rng);
    const hex = value => '0x' + value.toString(16);
    const small = () => 1 + randomInt(rng, 9);
    const blocks = [];
    for (let i = 0; i < count; i += 1) {
        const a = next();
        const b = next();
        const c = next();
        const mod = 2 + randomInt(rng, 251);
        const shape = randomInt(rng, 14);
        if (shape === 0) {
            blocks.push(`do local ${a}=${hex(1 + randomInt(rng, 0xffff))};local ${b}=${hex(1 + randomInt(rng, 0xff))};`
                + `local ${c}=(${a}*${b}+${hex(1 + randomInt(rng, 0xffff))})%${mod};if ${c}<0 then ${c}=0 end end`);
        } else if (shape === 1) {
            blocks.push(`do local ${a}=function(${b},${c})return (${b}+${c}*${hex(1 + randomInt(rng, 0xff))})%${mod} end;`
                + `local ${c}=${a}(${small()},${small()});if ${c}<0 then ${c}=0 end end`);
        } else if (shape === 2) {
            blocks.push(`do local ${a}=${hex(1 + randomInt(rng, 0xffff))}+${(1 + randomInt(rng, 900)) / 8}*${small()}%${mod};`
                + `local ${b}=${small()}e-${small()}*${1 + randomInt(rng, 99)};if ${a}<${b} then ${a}=${b} end end`);
        } else if (shape === 3) {
            blocks.push(`do local ${a}="\\108\\108\\49l1I\\48";local ${b}=#${a}+#"\\48\\48lI";if ${b}<0 then ${b}=0 end end`);
        } else if (shape === 4) {
            blocks.push(`do local ${a}=[==[ l1l1l 0O0oO lll lI1 ]==];if #${a}<0 then ${a}="" end end`);
        } else if (shape === 5) {
            blocks.push(`do local ${a}={["l1l"]=${small()},["0O0"]=true,["lI1"]=${hex(1 + randomInt(rng, 0xff))},`
                + `["l11"]={["0O0"]=${small()}}};local ${b}=${a}["l1l"] or 0 end`);
        } else if (shape === 6) {
            blocks.push(`do local ${a}=0;repeat ${a}=${a}+1 until ${a}>=${small()} or ${a}<0 end`);
        } else if (shape === 7) {
            const rising = rng() < 0.5;
            const from = rising ? small() : 20 + randomInt(rng, 40);
            const to = rising ? 10 + randomInt(rng, 40) : small();
            const step = (rising ? 1 : -1) * (1 + randomInt(rng, 3));
            blocks.push(`do local ${a}=0;for ${b}=${from},${to},${step} do ${a}=${a}+${b} end end`);
        } else if (shape === 8) {
            blocks.push(`do local ${a}=${small()};do local ${a}=${a}+${hex(1 + randomInt(rng, 0xff))};`
                + `do local ${a}=${a}%${mod};if ${a}<0 then ${a}=0 end end end end`);
        } else if (shape === 9) {
            blocks.push(`do local ${a}=${rng() < 0.5 ? 'true' : 'false'} and ${small()} or ${small()};`
                + `local ${b}=tostring(${a})=="" and 0 or ${a};if ${b}<0 then ${b}=0 end end`);
        } else if (shape === 10) {
            blocks.push(`do local ${a}={["Mode"]="l11l",["Flag"]=true,["Retry"]=${small()}};`
                + `local ${b}=${a}["Mode"]..${a}["Retry"];if #${b}<0 then ${b}="" end end`);
        } else if (shape === 11) {
            blocks.push(`do local ${a}=${small()};while ${a}>0 do ${a}=${a}-1 end end`);
        } else if (shape === 12) {
            blocks.push(`do local ${a}=("l1l1"):rep(${1 + randomInt(rng, 4)}).."0O0";local ${b}=${a}:len();if ${b}<0 then ${b}=0 end end`);
        } else {
            blocks.push(`do local ${a}=math.floor(${(1 + randomInt(rng, 4000)) / 16});`
                + `local ${b}=math.abs(${a}-${small()});if ${b}<0 then ${b}=0 end end`);
        }
        if (comments && rng() < 0.45) blocks.push('-- ' + noiseComment(rng));
    }
    return blocks.join('\n');
}

function armorOnce(source, config) {
    const rng = createRng();
    const nextName = createNameFactory(rng);

    const inner = prepareInner(source, rng, nextName, config.dead);
    const innerBytes = stringToBytes(inner);
    // Long inputs trade match depth for a bounded encode time so the browser
    // stays responsive on large Prometheus output.
    const depth = innerBytes.length > 512 * 1024 ? Math.min(config.depth, 24) : config.depth;
    const layout = {
        minMatch: 3 + randomInt(rng, 3),
        // splitPoint + (MAX_MATCH - minMatch) must stay inside one byte.
        splitPoint: 96 + randomInt(rng, 32),
        bigEndian: rng() < 0.5,
        bias: randomInt(rng, 2)
    };
    const compressed = lzssCompress(innerBytes, depth, layout.minMatch, layout.splitPoint, layout);

    const spec = maskSpec(rng);
    let payload = compressed;
    const passKeys = [];
    const passes = Math.max(1, config.passes);
    for (let i = 0; i < passes; i++) {
        const key = randomInt(rng, MASK_CAP);
        passKeys.push(key);
        payload = applyMask(payload, key, spec);
    }

    const parts = splitSegments(payload, config.segments);
    const keys = parts.map(() => randomInt(rng, MASK_CAP));
    const masked = parts.map((bytes, index) => applyMask(bytes, keys[index], spec));

    // The runtime rebuilds this same permutation from the seed, so only the
    // seed and the two mixing constants are shipped.
    const orderSpec = permutationSpec(rng);
    const perm = buildPermutation(orderSpec, masked.length);

    const alphabet = shuffleAlphabet(rng);
    const segments = perm.map(logical => ({
        b64: base64Encode(masked[logical - 1], alphabet),
        key: keys[logical - 1]
    }));

    const messageTexts = {
        executor: '[VoidedX] This executor cannot run protected scripts.',
        roblox: '[VoidedX] This copy must run inside Roblox.',
        start: '[VoidedX] This copy could not start. Run the loader again.'
    };
    const messages = {};
    for (const [name, text] of Object.entries(messageTexts)) {
        const key = 1 + randomInt(rng, 255);
        messages[name] = { key, table: maskedMessageTable(text, key, rng) };
    }
    const chunkName = Array.from({ length: 7 }, () => BASE64_ALPHABET[randomInt(rng, BASE64_ALPHABET.length)]).join('');

    const opaqueA = 23 + randomInt(rng, 200);
    const opaqueB = 29 + randomInt(rng, 200);
    const opaqueC = 11 + randomInt(rng, 700);
    const opaqueM = 37 + randomInt(rng, 80);

    const loader = buildLoader({
        names: {
            nextName,
            sbyte: nextName(), schar: nextName(), ssub: nextName(), slen: nextName(),
            sconcat: nextName(), sunpack: nextName(), floor: nextName(), type: nextName(),
            pcall: nextName(), rawequal: nextName(), error: nextName(), load: nextName(),
            info: nextName(), infoAlt: nextName(), native: nextName(), arg: nextName(),
            okProbe: nextName(), probeFn: nextName(), restore: nextName(), sethook: nextName(),
            debug: nextName(), gethook: nextName(), getgenv: nextName(), msg: nextName(), check: nextName(), probe: nextName(),
            alpha: nextName(), map: nextName(), b64: nextName(), unmask: nextName(),
            inflate: nextName(), adler: nextName(), sum2: nextName(), segs: nextName(),
            keys: nextName(), order: nextName(), passKeys: nextName(), compLen: nextName(),
            sum1: nextName(), sum3: nextName(), decode: nextName(), src: nextName(),
            fn: nextName(), err: nextName()
        },
        rng,
        alphabet,
        segments,
        messages,
        chunkName,
        passKeys,
        mask: spec,
        lz: layout,
        order: orderSpec,
        flush: {
            b64: 96 + randomInt(rng, 224),
            unmask: 96 + randomInt(rng, 224)
        },
        readPiece: 1024 + randomInt(rng, 7168),
        compressedLength: compressed.length,
        checksum1: adler32(compressed),
        checksum2: weightedSum(compressed),
        dead: config.dead,
        robloxCheck: config.robloxCheck,
        opaqueA,
        opaqueB,
        opaqueC,
        opaqueM,
        opaqueExpected: (opaqueA * opaqueB + opaqueC) % opaqueM
    });
    return messifyLua(loader, rng, config.layout);
}

export function armorVoidedxSource(source, options = {}) {
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error('The obfuscation engine returned an empty script.');
    }
    const level = options.level || 'medium';
    const base = LEVEL_CONFIG[level] || LEVEL_CONFIG.medium;
    const layout = options.layout === 'compact' ? 'compact' : 'messy';
    const config = { ...base, layout };

    // Nested containers: each layer decodes and loads the previous one inside
    // its own randomized VM. The Prometheus VM stack stays at one layer because
    // stacking Vmify corrupts real scripts; these independent VoidedX layers are
    // safe because every one of them is the same proven decode-then-load path.
    let text = armorOnce(source, config);
    const layerOption = Math.floor(Number(options.layers));
    const requestedLayers = Math.max(1, Math.min(
        Number.isFinite(layerOption) && layerOption > 0 ? layerOption : Number(base.layers) || 1,
        MAX_ARMOR_LAYERS
    ));
    for (let layer = 1; layer < requestedLayers; layer += 1) {
        if (text.length > MAX_ARMOR_NEST_CHARS) break;
        if (text.length * 1.35 > MAX_ARMOR_TOTAL_CHARS) break;
        text = armorOnce(text, config);
    }

    const bannerRng = createRng();
    const junkCount = options.junk === 'off'
        ? 0
        : options.junk === 'heavy'
            ? 34 + randomInt(bannerRng, 22)
            : 16 + randomInt(bannerRng, 14);
    return buildBanner() + '\n'
        + (junkCount ? buildJunkCode(bannerRng, junkCount, { comments: options.comments !== false }) + '\n' : '')
        + text;
}

export const ARMOR_LEVELS = Object.freeze(Object.keys(LEVEL_CONFIG));
export { MAX_ARMOR_LAYERS };
