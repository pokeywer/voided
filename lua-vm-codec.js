// VoidedX VM codec: payload compression, layered additive-mask encryption and
// base64 segmentation shared by the VM engine and the legacy wrapper.

export const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WINDOW_SIZE = 65536;
const MAX_MATCH = 130;
const MIN_MATCH = 3;

export function createRng() {
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

export function randomInt(rng, maxExclusive) {
    return Math.floor(rng() * maxExclusive);
}

export function shuffleAlphabet(rng) {
    const chars = BASE64_ALPHABET.split('');
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        const tmp = chars[i];
        chars[i] = chars[j];
        chars[j] = tmp;
    }
    return chars.join('');
}

export function base64Encode(bytes, alphabet = BASE64_ALPHABET) {
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

export function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return b * 65536 + a;
}

export function weightedSum(bytes) {
    let total = 0;
    for (let i = 0; i < bytes.length; i++) {
        total = (total + bytes[i] * (i + 1)) % 4294967296;
    }
    return total;
}

// Greedy LZSS with a 64 KiB window. Token layout:
//   0..127  -> literal run of value+1 bytes
//   128..255 -> match length (value-125) followed by a 16-bit offset
export function lzssCompress(bytes, depthLimit = 40) {
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

export function xorPass(bytes, key) {
    const out = new Uint8Array(bytes.length);
    let state = key % 4294967296;
    for (let i = 0; i < bytes.length; i++) {
        state = (state * 1664525 + 1013904223) % 4294967296;
        const mask = Math.floor(state / 16777216) % 256;
        out[i] = bytes[i] ^ mask;
    }
    return out;
}

// Additive variant of xorPass: no bitwise operators are needed to undo it, so
// the generated Lua stays valid on engines without XOR syntax.
export function addPass(bytes, key) {
    const out = new Uint8Array(bytes.length);
    let state = key % 4294967296;
    for (let i = 0; i < bytes.length; i++) {
        state = (state * 1664525 + 1013904223) % 4294967296;
        const mask = Math.floor(state / 16777216) % 256;
        out[i] = (bytes[i] + mask) % 256;
    }
    return out;
}

export function splitSegments(bytes, requested) {
    if (bytes.length === 0) return [bytes];
    const count = Math.max(1, Math.min(requested, bytes.length));
    const size = Math.ceil(bytes.length / count);
    const parts = [];
    for (let start = 0; start < bytes.length; start += size) {
        parts.push(bytes.subarray(start, Math.min(bytes.length, start + size)));
    }
    return parts;
}

export function createNameFactory(rng) {
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

export function buildDeadFunctions(nextName, rng, count) {
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
