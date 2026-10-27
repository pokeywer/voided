// VoidedX custom Lua/Luau obfuscation engine.
//
// The delivered script is compressed (LZSS), encrypted with a per-segment
// keystream, split into independently keyed base64 segments, and wrapped in a
// small randomized Lua decoder. The wrapper never builds a giant function and
// never uses `#` on executor-provided values, so it stays below Luau's
// 255-register limit and runs on executors that return userdata objects.
//
// High/Absolute add independent wrapper layers. Tamper checking adds a second
// integrity checksum and runtime reference checks. This is client-side
// protection: it raises the cost of static analysis and casual dumping, while
// the server-side loader shield remains the enforcement boundary.

export const ENGINE_VERSION = 2;

const LEVEL_CONFIG = Object.freeze({
    fast: { layers: 1, segments: 3, depth: 12, dead: 0 },
    low: { layers: 1, segments: 4, depth: 24, dead: 0 },
    medium: { layers: 1, segments: 6, depth: 40, dead: 1 },
    high: { layers: 2, segments: 10, depth: 64, dead: 2 },
    absolute: { layers: 3, segments: 14, depth: 96, dead: 3 }
});

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WINDOW_SIZE = 65536;
const MAX_MATCH = 130;
const MIN_MATCH = 3;
const FLUSH_BYTES = 96;

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
    let out = '';
    const n = bytes.length;
    for (let i = 0; i < n; i += 3) {
        const has1 = i + 1 < n;
        const has2 = i + 2 < n;
        const b0 = bytes[i];
        const b1 = has1 ? bytes[i + 1] : 0;
        const b2 = has2 ? bytes[i + 2] : 0;
        out += alphabet[b0 >> 2];
        out += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
        if (has1) out += alphabet[((b1 & 15) << 2) | (b2 >> 6)];
        if (has2) out += alphabet[b2 & 63];
    }
    return out;
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

// Greedy LZSS with a 64 KiB window. Token layout:
//   0..127  -> literal run of value+1 bytes
//   128..255 -> match length (value-125) followed by a 16-bit offset
function lzssCompress(bytes, depthLimit = 40) {
    const n = bytes.length;
    if (n === 0) return new Uint8Array(0);

    const hashSize = 1 << 16;
    const head = new Int32Array(hashSize).fill(-1);
    const prev = new Int32Array(n).fill(-1);

    let capacity = Math.max(1024, Math.min(n, 1 << 20));
    let out = new Uint8Array(capacity);
    let outLen = 0;

    const ensure = extra => {
        if (outLen + extra <= capacity) return;
        let nextCapacity = capacity;
        while (nextCapacity < outLen + extra) nextCapacity *= 2;
        const next = new Uint8Array(nextCapacity);
        next.set(out.subarray(0, outLen));
        out = next;
        capacity = nextCapacity;
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

function keystreamByte(state) {
    const next = (state * 1664525 + 1013904223) % 4294967296;
    return { state: next, byte: Math.floor(next / 16777216) % 256 };
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

function encodeSegments(compressed, requested, alphabet, rng) {
    const parts = splitSegments(compressed, requested);
    const baseKey = randomInt(rng, 4294967296);
    return parts.map((part, index) => {
        const key = (baseKey + index * 40503) % 4294967296;
        const cipher = new Uint8Array(part.length);
        let state = key;
        for (let i = 0; i < part.length; i++) {
            const step = keystreamByte(state);
            state = step.state;
            cipher[i] = part[i] ^ step.byte;
        }
        return { b64: base64Encode(cipher, alphabet), key };
    });
}

function createNameFactory(rng) {
    const used = new Set();
    return () => {
        let name;
        do {
            name = `_0x${Math.floor(rng() * 0xffffff).toString(16)}`;
        } while (used.has(name));
        used.add(name);
        return name;
    };
}

function buildDeadFunctions(nextName, rng, count) {
    let out = '';
    for (let i = 0; i < count; i++) {
        const fn = nextName();
        const a = nextName();
        const b = nextName();
        const t = nextName();
        const idx = nextName();
        const constant = 200 + randomInt(rng, 57);
        out += `local function ${fn}(${a},${b})\n`;
        out += `    local ${t}={}\n`;
        out += `    local ${idx}=1\n`;
        out += `    while ${idx}<=4 do\n`;
        out += `        ${t}[${idx}]=(${a}*${idx}+${b}+${constant})%257\n`;
        out += `        ${idx}=${idx}+1\n`;
        out += `    end\n`;
        out += `    return ${t}\n`;
        out += 'end\n';
    }
    return out;
}

function addSourceNoise(source, count, rng) {
    if (count <= 0 || source.startsWith('#!') || source.startsWith('--!')) return source;
    const nextName = createNameFactory(rng);
    return buildDeadFunctions(nextName, rng, count) + source;
}

function buildWrapper(compressed, config, rng) {
    const nextName = createNameFactory(rng);
    const alphabet = shuffleAlphabet(rng);
    const segments = encodeSegments(compressed, config.segmentCount, alphabet, rng);
    const checksum = adler32(compressed);
    const secondChecksum = weightedSum(compressed);
    const chunkLabel = `=vx${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}`;

    const load = nextName();
    const pcall = nextName();
    const sbyte = nextName();
    const schar = nextName();
    const ssub = nextName();
    const slen = nextName();
    const sconcat = nextName();
    const sunpack = nextName();
    const floor = nextName();
    const typeFn = nextName();
    const tostringFn = nextName();
    const rawequalFn = nextName();
    const infoFn = nextName();
    const bitFn = nextName();
    const bxorFn = nextName();
    const xorFn = nextName();
    const mapFn = nextName();
    const mapVal = nextName();
    const decFn = nextName();
    const inflateFn = nextName();
    const adlerFn = nextName();
    const sum2Fn = nextName();
    const checkFn = nextName();
    const stringFn = nextName();
    const segmentsVar = nextName();
    const keysVar = nextName();
    const segmentCountVar = nextName();
    const compressedLenVar = nextName();
    const checksumVar = nextName();
    const secondChecksumVar = nextName();
    const srcVar = nextName();
    const fnVar = nextName();
    const errVar = nextName();
    const okVar = nextName();
    const dead = buildDeadFunctions(nextName, rng, config.deadCount);

    const opaqueA = 17 + randomInt(rng, 240);
    const opaqueB = 19 + randomInt(rng, 240);
    const opaqueC = 7 + randomInt(rng, 500);
    const opaqueM = 31 + randomInt(rng, 60);
    const opaqueExpected = (opaqueA * opaqueB + opaqueC) % opaqueM;
    const tamper = config.tamperCheck;

    const lines = [];
    lines.push(`local ${load}=loadstring or load`);
    lines.push(`local ${pcall}=pcall`);
    lines.push(`local ${sbyte},${schar},${ssub},${slen}=string.byte,string.char,string.sub,string.len`);
    lines.push(`local ${sconcat}=table.concat`);
    lines.push(`local ${sunpack}=table.unpack or unpack`);
    lines.push(`local ${floor}=math.floor`);
    lines.push(`local ${typeFn}=type`);
    lines.push(`local ${tostringFn}=tostring`);
    lines.push(`local ${rawequalFn}=rawequal`);
    lines.push(`local ${infoFn}=${typeFn}(debug)=="table" and debug.info or nil`);
    lines.push(`local ${bitFn}=bit32`);
    lines.push(`local ${bxorFn}=${bitFn} and ${bitFn}.bxor or nil`);
    lines.push(`if not ${load} or not ${pcall} or not ${sunpack} then return error("[VoidedX] This executor cannot run protected scripts.",0) end`);
    lines.push('');
    lines.push(dead);
    lines.push(`local function ${xorFn}(a,b)`);
    lines.push(`    if ${bxorFn} then return ${bxorFn}(a,b) end`);
    lines.push('    local r=0');
    lines.push('    local p=1');
    lines.push('    while a>0 or b>0 do');
    lines.push('        local x=a%2');
    lines.push('        local y=b%2');
    lines.push('        if x~=y then r=r+p end');
    lines.push('        a=(a-x)/2');
    lines.push('        b=(b-y)/2');
    lines.push('        p=p*2');
    lines.push('    end');
    lines.push('    return r');
    lines.push('end');
    lines.push('');
    lines.push(`local function ${mapFn}()`);
    lines.push('    local m={}');
    lines.push(`    local a="${alphabet}"`);
    lines.push('    local i=1');
    lines.push(`    while i<=64 do`);
    lines.push(`        m[${sbyte}(a,i)]=i-1`);
    lines.push('        i=i+1');
    lines.push('    end');
    lines.push('    return m');
    lines.push('end');
    lines.push(`local ${mapVal}=${mapFn}()`);
    lines.push('');
    lines.push(`local function ${decFn}(s,key)`);
    lines.push(`    local n=${slen}(s)`);
    lines.push('    local out={}');
    lines.push('    local on=0');
    lines.push('    local cur={}');
    lines.push('    local cn=0');
    lines.push('    local i=1');
    lines.push('    local st=key%4294967296');
    lines.push('    while i<=n do');
    lines.push('        local rem=n-i+1');
    lines.push(`        local c1=${mapVal}[${sbyte}(s,i)] or 0`);
    lines.push(`        local c2=${mapVal}[${sbyte}(s,i+1)] or 0`);
    lines.push(`        local c3=${mapVal}[${sbyte}(s,i+2)] or 0`);
    lines.push(`        local c4=${mapVal}[${sbyte}(s,i+3)] or 0`);
    lines.push('        local v=c1*262144+c2*4096+c3*64+c4');
    lines.push(`        local b1=${floor}(v/65536)%256`);
    lines.push(`        local b2=${floor}(v/256)%256`);
    lines.push('        local b3=v%256');
    lines.push('        if rem>=2 then');
    lines.push('            st=(st*1664525+1013904223)%4294967296');
    lines.push('            cn=cn+1');
    lines.push(`            cur[cn]=${xorFn}(b1,${floor}(st/16777216)%256)`);
    lines.push(`            if cn>=${FLUSH_BYTES} then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)); cur={}; cn=0 end`);
    lines.push('        end');
    lines.push('        if rem>=3 then');
    lines.push('            st=(st*1664525+1013904223)%4294967296');
    lines.push('            cn=cn+1');
    lines.push(`            cur[cn]=${xorFn}(b2,${floor}(st/16777216)%256)`);
    lines.push(`            if cn>=${FLUSH_BYTES} then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)); cur={}; cn=0 end`);
    lines.push('        end');
    lines.push('        if rem>=4 then');
    lines.push('            st=(st*1664525+1013904223)%4294967296');
    lines.push('            cn=cn+1');
    lines.push(`            cur[cn]=${xorFn}(b3,${floor}(st/16777216)%256)`);
    lines.push(`            if cn>=${FLUSH_BYTES} then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)); cur={}; cn=0 end`);
    lines.push('        end');
    lines.push('        i=i+4');
    lines.push('    end');
    lines.push(`    if cn>0 then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)) end`);
    lines.push(`    return ${sconcat}(out)`);
    lines.push('end');
    lines.push('');
    lines.push(`local function ${inflateFn}(s)`);
    lines.push(`    local n=${slen}(s)`);
    lines.push('    local out={}');
    lines.push('    local on=0');
    lines.push('    local win={}');
    lines.push('    local wpos=0');
    lines.push('    local produced=0');
    lines.push('    local cur={}');
    lines.push('    local cn=0');
    lines.push('    local i=1');
    lines.push('    local function push(b)');
    lines.push('        cn=cn+1');
    lines.push('        cur[cn]=b');
    lines.push('        win[wpos]=b');
    lines.push('        wpos=(wpos+1)%65536');
    lines.push('        produced=produced+1');
    lines.push(`        if cn>=${FLUSH_BYTES} then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)); cur={}; cn=0 end`);
    lines.push('    end');
    lines.push('    while i<=n do');
    lines.push(`        local c=${sbyte}(s,i)`);
    lines.push('        i=i+1');
    lines.push('        if c<128 then');
    lines.push('            local len=c+1');
    lines.push('            local j=0');
    lines.push('            while j<len do');
    lines.push(`                push(${sbyte}(s,i))`);
    lines.push('                i=i+1');
    lines.push('                j=j+1');
    lines.push('            end');
    lines.push('        else');
    lines.push('            local len=c-125');
    lines.push(`            local lo=${sbyte}(s,i) or 0`);
    lines.push(`            local hi=${sbyte}(s,i+1) or 0`);
    lines.push('            i=i+2');
    lines.push('            local off=lo+hi*256');
    lines.push('            if off<1 or off>produced then return nil end');
    lines.push('            local j=0');
    lines.push('            while j<len do');
    lines.push('                push(win[(wpos-off)%65536])');
    lines.push('                j=j+1');
    lines.push('            end');
    lines.push('        end');
    lines.push('    end');
    lines.push(`    if cn>0 then on=on+1; out[on]=${schar}(${sunpack}(cur,1,cn)) end`);
    lines.push(`    return ${sconcat}(out)`);
    lines.push('end');
    lines.push('');
    lines.push(`local function ${adlerFn}(s)`);
    lines.push(`    local n=${slen}(s)`);
    lines.push('    local a=1');
    lines.push('    local b=0');
    lines.push('    local i=1');
    lines.push('    while i<=n do');
    lines.push(`        a=(a+${sbyte}(s,i))%65521`);
    lines.push('        b=(b+a)%65521');
    lines.push('        i=i+1');
    lines.push('    end');
    lines.push('    return b*65536+a');
    lines.push('end');
    if (tamper) {
        lines.push('');
        lines.push(`local function ${sum2Fn}(s)`);
        lines.push(`    local n=${slen}(s)`);
        lines.push('    local t=0');
        lines.push('    local i=1');
        lines.push('    while i<=n do');
        lines.push(`        t=(t+${sbyte}(s,i)*i)%4294967296`);
        lines.push('        i=i+1');
        lines.push('    end');
        lines.push('    return t');
        lines.push('end');
    }
    lines.push('');
    lines.push(`local function ${checkFn}()`);
    lines.push(`    if (loadstring or load)~=${load} then return false end`);
    lines.push(`    if pcall~=${pcall} then return false end`);
    lines.push(`    if string.byte~=${sbyte} or string.char~=${schar} or string.sub~=${ssub} or string.len~=${slen} then return false end`);
    lines.push(`    if table.concat~=${sconcat} then return false end`);
    lines.push(`    if rawequal~=${rawequalFn} then return false end`);
    lines.push(`    if ${infoFn} and (${typeFn}(debug)~="table" or debug.info~=${infoFn}) then return false end`);
    lines.push(`    if ${bitFn} and ${bitFn}.bxor~=${bxorFn} then return false end`);
    lines.push('    return true');
    lines.push('end');
    lines.push('');
    lines.push(`local ${segmentsVar}={`);
    for (const item of segments) lines.push(`"${item.b64}",`);
    lines.push('}');
    lines.push(`local ${keysVar}={${segments.map(item => item.key).join(',')}}`);
    lines.push(`local ${segmentCountVar}=${segments.length}`);
    lines.push(`local ${compressedLenVar}=${compressed.length}`);
    lines.push(`local ${checksumVar}=${checksum}`);
    if (tamper) lines.push(`local ${secondChecksumVar}=${secondChecksum}`);
    lines.push('');
    lines.push(`local function ${stringFn}()`);
    lines.push('    local parts={}');
    lines.push('    local i=1');
    lines.push(`    while i<=${segmentCountVar} do`);
    lines.push(`        parts[i]=${decFn}(${segmentsVar}[i],${keysVar}[i])`);
    lines.push('        i=i+1');
    lines.push('    end');
    lines.push(`    local comp=${sconcat}(parts)`);
    lines.push('    parts=nil');
    lines.push(`    if ${slen}(comp)~=${compressedLenVar} then return nil end`);
    lines.push(`    if ${adlerFn}(comp)~=${checksumVar} then return nil end`);
    if (tamper) lines.push(`    if ${sum2Fn}(comp)~=${secondChecksumVar} then return nil end`);
    lines.push(`    local src=${inflateFn}(comp)`);
    lines.push('    comp=nil');
    lines.push('    return src');
    lines.push('end');
    lines.push('');
    lines.push(`if (${opaqueA}*${opaqueB}+${opaqueC})%${opaqueM}~=${opaqueExpected} then return end`);
    lines.push(`if not ${checkFn}() then return error("[VoidedX] This session was blocked because the runtime environment was modified.",0) end`);
    lines.push(`local ${srcVar}=${stringFn}()`);
    lines.push(`if not ${srcVar} then return error("[VoidedX] The protected script failed its integrity check. Run the loader again.",0) end`);
    lines.push(`if not ${checkFn}() then return error("[VoidedX] This session was blocked because the runtime environment was modified.",0) end`);
    lines.push(`local ${okVar},${fnVar},${errVar}=${pcall}(${load},${srcVar},"${chunkLabel}")`);
    lines.push(`${srcVar}=nil`);
    lines.push(`if not ${okVar} then return error(${tostringFn}(${fnVar}),0) end`);
    lines.push(`if not ${fnVar} then return error(${tostringFn}(${errVar}),0) end`);
    lines.push(`return ${fnVar}()`);
    lines.push('');

    return lines.join('\n');
}

function wrapLayer(code, config, rng) {
    const bytes = new TextEncoder().encode(code);
    const compressed = lzssCompress(bytes, config.depth);
    return buildWrapper(compressed, config, rng);
}

export function obfuscateVaultSource(source, options = {}) {
    if (typeof source !== 'string') throw new Error('Paste a LuaU script before obfuscating it.');
    const requestedLevel = options.level === 'auto' ? 'medium' : options.level;
    const level = LEVEL_CONFIG[requestedLevel] ? requestedLevel : 'medium';
    const preset = LEVEL_CONFIG[level];
    const tamperCheck = options.tamperCheck === true || level === 'absolute';
    const expanded = level !== 'fast' && (options.expandedTransforms === true || level === 'absolute');
    const rng = createRng();

    const config = {
        layers: preset.layers,
        segmentCount: expanded ? Math.min(24, preset.segments * 2) : preset.segments,
        depth: preset.depth,
        deadCount: preset.dead + (expanded ? 2 : 0),
        tamperCheck
    };

    let code = addSourceNoise(source, config.deadCount + (expanded ? 2 : 0), rng);

    for (let layer = 0; layer < config.layers; layer++) {
        code = wrapLayer(code, config, rng);
    }

    return code;
}
