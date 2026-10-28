// VoidedX armor for Prometheus-generated copies.
//
// Prometheus output is recognizable to its own devirtualizers, so the site
// repacks it: the watermark and helper names are removed, the chunk is wrapped
// in a generator function, LZSS-compressed, masked in layers, split into
// shuffled segments, and hidden behind a randomized Lua loader with integrity
// checks. The inner VM settings are unchanged; this module only adds the
// VoidedX container around them.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WINDOW_SIZE = 65536;
const MAX_MATCH = 130;
const MIN_MATCH = 3;
const FLUSH_BYTES = 192;

const LEVEL_CONFIG = Object.freeze({
    fast: { segments: 6, passes: 1, depth: 24, dead: 1, hookGuard: false, robloxCheck: true },
    low: { segments: 10, passes: 2, depth: 44, dead: 2, hookGuard: false, robloxCheck: true },
    medium: { segments: 14, passes: 4, depth: 60, dead: 3, hookGuard: false, robloxCheck: true },
    high: { segments: 18, passes: 4, depth: 72, dead: 4, hookGuard: true, robloxCheck: true },
    absolute: { segments: 24, passes: 5, depth: 104, dead: 5, hookGuard: true, robloxCheck: true }
});

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

function createNameFactory(rng) {
    const used = new Set();
    return () => {
        let name;
        do {
            name = `_0x${randomInt(rng, 0xffffff).toString(16).padStart(6, '0')}`;
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

function addMask(bytes, key) {
    const out = new Uint8Array(bytes.length);
    let state = key % 4294967296;
    for (let i = 0; i < bytes.length; i++) {
        state = (state * 1664525 + 1013904223) % 4294967296;
        out[i] = (bytes[i] + Math.floor(state / 16777216) % 256) % 256;
    }
    return out;
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

// Greedy LZSS with a 64 KiB window. Tokens:
//   0..127  -> literal run of value+1 bytes
//   128..255 -> match length (value-125) followed by a 16-bit offset
function lzssCompress(bytes, depthLimit) {
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
            const len = Math.min(128, end - literalStart);
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

        if (bestLen >= MIN_MATCH) {
            flushLiterals(i);
            emit(128 + (bestLen - MIN_MATCH));
            emit(bestOffset & 0xff);
            emit((bestOffset >> 8) & 0xff);
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

function prepareInner(source, rng, nextName, deadCount) {
    let inner = disguiseWatermark(source);

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

function messifyLua(code, rng) {
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
            const gap = needsTokenGap(prev, token) ? ' ' : (rng() < 0.18 ? ' ' : '');
            out += gap;
        }
        out += token;
        sinceBreak += 1;
        // A break before `(`/`{`/`[` turns the following statement into a
        // continuation call or index, which Luau rejects as ambiguous syntax.
        const breakSafe = token !== '(' && token !== '{' && token !== '['
            && tokens[t + 1] !== '(' && tokens[t + 1] !== '{' && tokens[t + 1] !== '['
            && prev !== 'return';
        if (breakSafe && sinceBreak > 30 && (rng() < 0.14 || sinceBreak > 240)) {
            out += rng() < 0.02 ? '\n\n' : '\n';
            sinceBreak = 0;
        }
    }
    return out + '\n';
}

function buildLoader(o) {
    const p = o.names;
    const lines = [];
    const add = line => lines.push(line);

    add(`local ${p.sbyte},${p.schar},${p.ssub},${p.slen}=string.byte,string.char,string.sub,string.len`);
    add(`local ${p.sconcat}=table.concat`);
    add(`local ${p.sunpack}=table.unpack or unpack`);
    add(`local ${p.floor}=math.floor`);
    add(`local ${p.type}=type`);
    add(`local ${p.pcall}=pcall`);
    add(`local ${p.rawequal}=rawequal`);
    add(`local ${p.error}=error`);
    add(`local ${p.load}=loadstring or load`);
    add(`local ${p.debug}=debug`);
    add(`local ${p.gethook}=${p.debug} and ${p.debug}.gethook or nil`);
    add(`local ${p.msg}=function(t,k) local o="" for i=1,#t do o=o..${p.schar}((t[i]-k)%256) end return ${p.error}(o,0) end`);
    add(`if not ${p.load} or not ${p.sconcat} or not ${p.sunpack} then return ${p.msg}(${o.messages.executor.table},${o.messages.executor.key}) end`);
    add('');

    add(buildDeadLua(p.nextName, o.rng, o.dead));
    add('');

    add(`local ${p.check}=function()`);
    add(`    if string.byte~=${p.sbyte} or string.char~=${p.schar} or string.sub~=${p.ssub} or string.len~=${p.slen} then return false end`);
    add(`    if table.concat~=${p.sconcat} then return false end`);
    add(`    if rawequal~=${p.rawequal} then return false end`);
    add(`    if ${p.pcall}(function() ${p.error}("vx_probe",0) end) then return false end`);
    if (o.hookGuard) {
        add(`    if ${p.gethook} then`);
        add(`        local ok,hook=${p.pcall}(${p.gethook})`);
        add('        if ok and hook~=nil then return false end');
        add('    end');
    }
    add('    return true');
    add('end');
    add('');

    if (o.robloxCheck) {
        add(`local ${p.probe}=${p.pcall}(function()`);
        add('    local players=game:GetService("Players")');
        add('    return players~=nil');
        add('end)');
        add(`if not ${p.probe} then return ${p.msg}(${o.messages.roblox.table},${o.messages.roblox.key}) end`);
        add('');
    }

    add(`local ${p.alpha}=${splitAlphabetLiteral(o.alphabet, o.rng)}`);
    add(`local ${p.map}={}`);
    add(`do local i=1 while i<=64 do ${p.map}[${p.sbyte}(${p.alpha},i)]=i-1 i=i+1 end end`);
    add('');

    add(`local ${p.b64}=function(s)`);
    add(`    local n=${p.slen}(s)`);
    add('    local out={}');
    add('    local on=0');
    add('    local buf={}');
    add('    local bn=0');
    add('    local i=1');
    add('    while i<=n do');
    add(`        local c1=${p.map}[${p.sbyte}(s,i)] or 0`);
    add(`        local c2=${p.map}[${p.sbyte}(s,i+1)] or 0`);
    add(`        local c3=${p.map}[${p.sbyte}(s,i+2)] or 0`);
    add(`        local c4=${p.map}[${p.sbyte}(s,i+3)] or 0`);
    add('        local v=c1*262144+c2*4096+c3*64+c4');
    add(`        bn=bn+1 buf[bn]=${p.floor}(v/65536)%256`);
    add(`        if i+2<=n then bn=bn+1 buf[bn]=${p.floor}(v/256)%256 end`);
    add(`        if i+3<=n then bn=bn+1 buf[bn]=v%256 end`);
    add(`        if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) buf={} bn=0 end`);
    add('        i=i+4');
    add('    end');
    add(`    if bn>0 then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) end`);
    add(`    return ${p.sconcat}(out)`);
    add('end');
    add('');

    add(`local ${p.unmask}=function(s,key)`);
    add(`    local n=${p.slen}(s)`);
    add('    local out={}');
    add('    local on=0');
    add('    local buf={}');
    add('    local bn=0');
    add('    local st=key%4294967296');
    add('    local i=1');
    add('    while i<=n do');
    add(`        local ch=${p.sbyte}(s,i)`);
    add('        st=(st*1664525+1013904223)%4294967296');
    add(`        bn=bn+1 buf[bn]=(ch-${p.floor}(st/16777216)%256)%256`);
    add(`        if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) buf={} bn=0 end`);
    add('        i=i+1');
    add('    end');
    add(`    if bn>0 then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) end`);
    add(`    return ${p.sconcat}(out)`);
    add('end');
    add('');

    add(`local ${p.inflate}=function(s)`);
    add(`    local n=${p.slen}(s)`);
    add('    local out={}');
    add('    local on=0');
    add('    local win={}');
    add('    local wpos=0');
    add('    local produced=0');
    add('    local buf={}');
    add('    local bn=0');
    add('    local i=1');
    add('    while i<=n do');
    add(`        local c=${p.sbyte}(s,i)`);
    add('        i=i+1');
    add('        if c<128 then');
    add('            local stop=i+c+1');
    add('            while i<stop do');
    add(`                local v=${p.sbyte}(s,i)`);
    add('                i=i+1');
    add('                bn=bn+1 buf[bn]=v');
    add('                win[wpos]=v');
    add('                wpos=wpos+1');
    add('                if wpos==65536 then wpos=0 end');
    add('                produced=produced+1');
    add(`                if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) buf={} bn=0 end`);
    add('            end');
    add('        else');
    add('            local len=c-125');
    add(`            local lo=${p.sbyte}(s,i) or 0`);
    add(`            local hi=${p.sbyte}(s,i+1) or 0`);
    add('            i=i+2');
    add('            local off=lo+hi*256');
    add('            if off<1 or off>produced then return nil end');
    add('            local j=0');
    add('            while j<len do');
    add('                local v=win[(wpos-off)%65536]');
    add('                bn=bn+1 buf[bn]=v');
    add('                win[wpos]=v');
    add('                wpos=wpos+1');
    add('                if wpos==65536 then wpos=0 end');
    add('                produced=produced+1');
    add(`                if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) buf={} bn=0 end`);
    add('                j=j+1');
    add('            end');
    add('        end');
    add('    end');
    add(`    if bn>0 then on=on+1 out[on]=${p.schar}(${p.sunpack}(buf,1,bn)) end`);
    add(`    return ${p.sconcat}(out)`);
    add('end');
    add('');

    add(`local ${p.adler}=function(s)`);
    add(`    local n=${p.slen}(s)`);
    add('    local a=1');
    add('    local b=0');
    add('    local i=1');
    add('    while i<=n do');
    add(`        a=(a+${p.sbyte}(s,i))%65521`);
    add('        b=(b+a)%65521');
    add('        i=i+1');
    add('    end');
    add('    return b*65536+a');
    add('end');
    add('');

    add(`local ${p.sum2}=function(s)`);
    add(`    local n=${p.slen}(s)`);
    add('    local t=0');
    add('    local i=1');
    add('    while i<=n do');
    add(`        t=(t+${p.sbyte}(s,i)*i)%4294967296`);
    add('        i=i+1');
    add('    end');
    add('    return t');
    add('end');
    add('');

    add(`local ${p.segs}={`);
    for (const segment of o.segments) add(`    ${luaString(segment.b64)},`);
    add('}');
    add(`local ${p.keys}={${o.segments.map(segment => numericExpr(segment.key, o.rng)).join(',')}}`);
    add(`local ${p.order}={${o.segments.map(segment => segment.order).join(',')}}`);
    add(`local ${p.passKeys}={${o.passKeys.map(key => numericExpr(key, o.rng)).join(',')}}`);
    add(`local ${p.compLen}=${numericExpr(o.compressedLength, o.rng)}`);
    add(`local ${p.sum1}=${numericExpr(o.checksum1, o.rng)}`);
    add(`local ${p.sum3}=${numericExpr(o.checksum2, o.rng)}`);
    add('');

    add(`local ${p.decode}=function()`);
    add('    local parts={}');
    add(`    local i=1`);
    add(`    while i<=${o.segments.length} do`);
    add(`        parts[${p.order}[i]]=${p.unmask}(${p.b64}(${p.segs}[i]),${p.keys}[i])`);
    add('        i=i+1');
    add('    end');
    add(`    local data=${p.sconcat}(parts)`);
    add('    parts=nil');
    add(`    local k=${o.passKeys.length}`);
    add(`    while k>=1 do data=${p.unmask}(data,${p.passKeys}[k]) k=k-1 end`);
    add(`    if ${p.slen}(data)~=${p.compLen} then return nil end`);
    add(`    if ${p.adler}(data)~=${p.sum1} then return nil end`);
    add(`    if ${p.sum2}(data)~=${p.sum3} then return nil end`);
    add(`    local raw=${p.inflate}(data)`);
    add('    data=nil');
    add('    return raw');
    add('end');
    add('');

    add(`if (${o.opaqueA}*${o.opaqueB}+${o.opaqueC})%${o.opaqueM}~=${o.opaqueExpected} then return end`);
    add(`if not ${p.check}() then return ${p.msg}(${o.messages.blocked.table},${o.messages.blocked.key}) end`);
    add(`local ${p.src}=${p.decode}()`);
    add(`if not ${p.src} then return ${p.msg}(${o.messages.integrity.table},${o.messages.integrity.key}) end`);
    add(`if not ${p.check}() then return ${p.msg}(${o.messages.blocked.table},${o.messages.blocked.key}) end`);
    add(`local ${p.fn},${p.err}=${p.load}(${p.src},"=${o.chunkName}")`);
    add('if not ' + p.fn + ' then');
    add(`    return ${p.msg}(${o.messages.start.table},${o.messages.start.key})`);
    add('end');
    add(`return ${p.fn}()`);

    return lines.join('\n');
}

export function armorVoidedxSource(source, options = {}) {
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error('The obfuscation engine returned an empty script.');
    }
    const level = options.level || 'medium';
    const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.medium;
    const rng = createRng();
    const nextName = createNameFactory(rng);

    const inner = prepareInner(source, rng, nextName, config.dead);
    const innerBytes = stringToBytes(inner);
    // Long inputs trade match depth for a bounded encode time so the browser
    // stays responsive on large Prometheus output.
    const depth = innerBytes.length > 512 * 1024 ? Math.min(config.depth, 24) : config.depth;
    const compressed = lzssCompress(innerBytes, depth);

    let payload = compressed;
    const passKeys = [];
    const passes = Math.max(1, config.passes);
    for (let i = 0; i < passes; i++) {
        const key = randomInt(rng, 4294967296);
        passKeys.push(key);
        payload = addMask(payload, key);
    }

    const parts = splitSegments(payload, config.segments);
    const keys = [];
    for (let i = 0; i < parts.length; i++) {
        const key = randomInt(rng, 4294967296);
        keys.push(key);
        parts[i] = addMask(parts[i], key);
    }

    const order = parts.map((_, index) => index + 1);
    for (let i = order.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }

    const alphabet = shuffleAlphabet(rng);
    const segments = order.map((logicalIndex, storedIndex) => ({
        b64: base64Encode(parts[logicalIndex - 1], alphabet),
        key: keys[logicalIndex - 1],
        order: logicalIndex
    }));

    const messageTexts = {
        executor: '[VoidedX] This executor cannot run protected scripts.',
        roblox: '[VoidedX] This copy must run inside Roblox.',
        blocked: '[VoidedX] This copy was blocked because the runtime was modified.',
        integrity: '[VoidedX] This copy failed its integrity check. Run the loader again.',
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
            debug: nextName(), gethook: nextName(), msg: nextName(), check: nextName(), probe: nextName(),
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
        compressedLength: compressed.length,
        checksum1: adler32(compressed),
        checksum2: weightedSum(compressed),
        dead: config.dead,
        hookGuard: config.hookGuard,
        robloxCheck: config.robloxCheck,
        opaqueA,
        opaqueB,
        opaqueC,
        opaqueM,
        opaqueExpected: (opaqueA * opaqueB + opaqueC) % opaqueM
    });
    return messifyLua(loader, rng);
}

export const ARMOR_LEVELS = Object.freeze(Object.keys(LEVEL_CONFIG));
