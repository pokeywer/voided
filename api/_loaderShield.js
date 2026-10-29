import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value) {
    return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let bit = 0; bit < 8; bit++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

export function normalizeSeed(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0x9E3779B9;
    return (parsed >>> 0) || 0x9E3779B9;
}

export function nextSeedState(state) {
    let value = state >>> 0;
    value = (value ^ (value << 13)) >>> 0;
    value = (value ^ (value >>> 17)) >>> 0;
    value = (value ^ (value << 5)) >>> 0;
    return value >>> 0;
}

export function xorKeystream(input, seed) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
    const output = Buffer.allocUnsafe(buffer.length);
    let state = normalizeSeed(seed);
    for (let i = 0; i < buffer.length; i += 4) {
        state = nextSeedState(state);
        output[i] = buffer[i] ^ ((state >>> 24) & 0xFF);
        if (i + 1 < buffer.length) output[i + 1] = buffer[i + 1] ^ ((state >>> 16) & 0xFF);
        if (i + 2 < buffer.length) output[i + 2] = buffer[i + 2] ^ ((state >>> 8) & 0xFF);
        if (i + 3 < buffer.length) output[i + 3] = buffer[i + 3] ^ (state & 0xFF);
    }
    return output;
}

export function encodeXorBase64(value, seed) {
    return xorKeystream(value, seed).toString('base64url');
}

export function choosePartCount(byteLength) {
    const length = Number(byteLength) || 0;
    if (length <= 16384) return 3;
    return Math.max(3, Math.min(12, Math.ceil(length / 65536) + 2));
}

export function buildShield({ code, trace }) {
    const source = String(code ?? '');
    const seed = normalizeSeed(randomBytes(4).readUInt32BE(0));
    return {
        seed,
        seedHex: seed.toString(16).padStart(8, '0'),
        trace: String(trace || ''),
        hash: sha256Hex(source)
    };
}

export function encryptParts(code, seed) {
    const cipher = xorKeystream(code, seed);
    const count = choosePartCount(cipher.length);
    const size = Math.ceil(cipher.length / count) || 1;
    const parts = [];
    for (let i = 0; i < count; i++) {
        parts.push(cipher.subarray(i * size, Math.min((i + 1) * size, cipher.length)).toString('base64url'));
    }
    return parts;
}

// Integrity travels as a checksum of the ciphertext the client received. The
// loader verifies it before decrypting, so a mangled transfer is caught without
// publishing a checksum of the plaintext for someone to check a decode against.
export function cipherTag(parts) {
    const buffers = (Array.isArray(parts) ? parts : []).map(part => Buffer.from(String(part || ''), 'base64url'));
    return crc32(Buffer.concat(buffers));
}

export function watermarkPrefix(trace) {
    const safe = String(trace || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
    return `--[[vx:${safe}]]\n`;
}

export const TAMPER_FLAGS = new Set([
    'http_swapped',
    'load_swapped',
    'json_swapped',
    'string_swapped',
    'table_swapped',
    'pcall_swapped',
    'debug_swapped',
    'rawequal_swapped',
    'print_swapped',
    'builtin_swapped',
    'env_swapped',
    'service_swapped',
    'urlencode_swapped',
    'task_swapped',
    'honeypot_triggered',
    'payload_crc_mismatch',
    'payload_trace_mismatch',
    'payload_shape_invalid',
    'order_invalid',
    'watermark_missing'
]);

export const HIGH_CONFIDENCE_FLAGS = new Set([
    'http_swapped',
    'load_swapped',
    'json_swapped',
    'string_swapped',
    'table_swapped',
    'pcall_swapped',
    'debug_swapped',
    'rawequal_swapped',
    'honeypot_triggered',
    'payload_crc_mismatch',
    'payload_trace_mismatch',
    'order_invalid',
    'watermark_missing'
]);

export function normalizeFlags(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    const flags = [];
    for (const entry of raw.split(',')) {
        const flag = entry.trim().toLowerCase().slice(0, 48);
        if (!TAMPER_FLAGS.has(flag) || flags.includes(flag)) continue;
        flags.push(flag);
        if (flags.length >= 16) break;
    }
    return flags;
}

export function isBlockingFlags(flags) {
    return (Array.isArray(flags) ? flags : []).some(flag => HIGH_CONFIDENCE_FLAGS.has(flag));
}