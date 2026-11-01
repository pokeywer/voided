import { deflateRawSync, inflateRawSync } from "zlib";
export function base85Encode(data) {
    let padded = data;
    if (data.length % 4 !== 0) {
        const padLen = 4 - (data.length % 4);
        padded = new Uint8Array(data.length + padLen);
        padded.set(data);
    }
    let result = "";
    for (let i = 0; i < padded.length; i += 4) {
        const val = (padded[i] << 24) |
            (padded[i + 1] << 16) |
            (padded[i + 2] << 8) |
            padded[i + 3];
        const uval = val >>> 0;
        if (uval === 0) {
            result += "z";
            continue;
        }
        let v = uval;
        const c = new Array(5);
        for (let j = 4; j >= 0; j--) {
            c[j] = String.fromCharCode(33 + (v % 85));
            v = Math.floor(v / 85);
        }
        result += c.join("");
    }
    return result;
}
export function base85Decode(str) {
    const result = [];
    let i = 0;
    str = str.replace(/z/g, "!!!!!");
    while (i < str.length) {
        if (i + 5 <= str.length) {
            let val = 0;
            for (let j = 0; j < 5; j++) {
                val = val * 85 + (str.charCodeAt(i + j) - 33);
            }
            result.push((val >>> 24) & 0xFF);
            result.push((val >>> 16) & 0xFF);
            result.push((val >>> 8) & 0xFF);
            result.push(val & 0xFF);
            i += 5;
        }
        else {
            const remaining = str.length - i;
            let val = 0;
            for (let j = 0; j < remaining; j++) {
                val = val * 85 + (str.charCodeAt(i + j) - 33);
            }
            for (let j = remaining; j < 5; j++) {
                val = val * 85 + 84;
            }
            for (let j = 0; j < remaining - 1; j++) {
                result.push((val >>> (24 - j * 8)) & 0xFF);
            }
            i += remaining;
        }
    }
    return new Uint8Array(result);
}
function adler32(data) {
    let a = 1, b = 0;
    const MOD = 65521;
    let idx = 0;
    while (idx < data.length) {
        const end = Math.min(idx + 5552, data.length);
        for (; idx < end; idx++) {
            a += data[idx];
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    return b * 65536 + a;
}
/**
 * The S-Box and keystream are not stored in the output at all: both sides regenerate them from a
 * 32-bit seed with this LCG, so there is no 256-entry table left to grep out of a shipped file.
 * Every step stays below 2^53 so doubles and Luau numbers agree exactly; the call order
 * (key length, then shuffle, then keystream) must match the emitted Luau.
 */
export const LCG_MUL = 1664525;
export const LCG_ADD = 1013904223;
export const LCG_MOD = 4294967296;
export function deriveKeys(seed) {
    let sd = seed >>> 0;
    const nxt = () => {
        sd = (sd * LCG_MUL + LCG_ADD) % LCG_MOD;
        return sd;
    };
    const keyLen = 20 + (nxt() % 13);
    const sbox = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
        const j = nxt() % (i + 1);
        [sbox[i], sbox[j]] = [sbox[j], sbox[i]];
    }
    const invSbox = new Array(256);
    for (let i = 0; i < 256; i++)
        invSbox[sbox[i]] = i;
    const xorKey = [];
    for (let i = 0; i < keyLen; i++)
        xorKey.push(nxt() % 256);
    return { keyLen, sbox, invSbox, xorKey };
}
function generateSBox(rng) {
    const sbox = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [sbox[i], sbox[j]] = [sbox[j], sbox[i]];
    }
    return sbox;
}
function invertSBox(sbox) {
    const inv = new Array(256);
    for (let i = 0; i < 256; i++) {
        inv[sbox[i]] = i;
    }
    return inv;
}
export function encryptAndEncode(input, rng) {
    const encoder = new TextEncoder();
    const raw = encoder.encode(input);
    const origLen = raw.length;
    const checksum = adler32(raw);
    const seed = Math.floor(rng() * LCG_MOD) >>> 0;
    const { keyLen, sbox, invSbox, xorKey } = deriveKeys(seed);
    const substituted = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        substituted[i] = sbox[raw[i]];
    }
    const encrypted = new Uint8Array(substituted.length);
    encrypted[0] = substituted[0] ^ xorKey[0];
    for (let i = 1; i < substituted.length; i++) {
        encrypted[i] = substituted[i] ^ xorKey[i % keyLen] ^ encrypted[i - 1];
    }
    const blob = base85Encode(encrypted);
    return { blob, xorKey, invSbox, checksum, origLen, seed, keyLen };
}
export function compressToBase85(input) {
    const encoder = new TextEncoder();
    return base85Encode(encoder.encode(input));
}
export function compressBytesToBase85(input) {
    return base85Encode(input);
}
export function compress(input) {
    return deflateRawSync(input, { level: 9 });
}
export function decompress(input) {
    return inflateRawSync(input);
}
//# sourceMappingURL=lzma.js.map