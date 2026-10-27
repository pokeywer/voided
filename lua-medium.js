import { obfuscateVaultSource } from './lua-vault.js';

let nextJobId = 0;
let lastSuccessfulObfuscation = null;

// Keep Auto's two-layer mode for tiny scripts; larger sources default to the
// single-layer Medium profile to reduce runtime and vault-size overhead.
export const AUTO_HIGH_BYTE_THRESHOLD = 16 * 1024;
// Retained aliases for any callers that imported the earlier threshold names.
export const AUTO_LOW_BYTE_THRESHOLD = AUTO_HIGH_BYTE_THRESHOLD;
export const AUTO_LOW_CHAR_THRESHOLD = AUTO_HIGH_BYTE_THRESHOLD;
export const MAX_VAULT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_OBFUSCATION_SOURCE_BYTES = 4 * 1024 * 1024;
// Keep ordinary scripts directly readable in Firestore for owner audits.
// Larger sources stay compressed so the source + execution copy can fit in a document.
export const MAX_READABLE_VAULT_SOURCE_BYTES = 128 * 1024;
export const MAX_OBFUSCATED_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_STORED_OBFUSCATED_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_OBFUSCATED_PREVIEW_BYTES = 1024 * 1024;
// Firestore documents are limited to 1 MiB. Keep the app's serialized JSON
// budget below that hard limit so field/index overhead has room.
export const MAX_VAULT_DOCUMENT_ESTIMATE_BYTES = 920 * 1024;

const LEVELS = new Set(['fast', 'low', 'medium', 'high', 'absolute']);
const MAX_STORED_ENCODED_OBFUSCATED_BYTES = 920 * 1024;
const WORKER_TIMEOUT_MS = 180_000;

export function getUtf8ByteLength(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return new TextEncoder().encode(text).byteLength;
}

export function resolveObfuscationLevel(source, requestedLevel = 'auto') {
    if (LEVELS.has(requestedLevel)) return requestedLevel;
    return getUtf8ByteLength(source) > AUTO_HIGH_BYTE_THRESHOLD ? 'medium' : 'high';
}

function obfuscateOnMainThread(source, options) {
    return new Promise(resolve => resolve(obfuscateVaultSource(source, options)));
}

function obfuscateInWorker(source, options) {
    if (typeof Worker !== 'function') return obfuscateOnMainThread(source, options);

    return new Promise((resolve, reject) => {
        const jobId = ++nextJobId;
        let worker;
        let settled = false;
        const finish = (error, output) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            try { worker?.terminate(); } catch {}
            if (error) reject(error);
            else resolve(output);
        };
        const timeoutId = setTimeout(() => finish(new Error('The obfuscation engine timed out. Try a lower strength or reduce the script size.')), WORKER_TIMEOUT_MS);

        try {
            worker = new Worker(new URL('./lua-vault-worker.js', import.meta.url), { type: 'module' });
        } catch {
            // Module workers are unavailable in some embedded browsers. Running
            // on the main thread is slower but produces the same output.
            settled = true;
            clearTimeout(timeoutId);
            obfuscateOnMainThread(source, options).then(resolve, reject);
            return;
        }

        worker.addEventListener('message', event => {
            const message = event.data;
            if (!message || message.id !== jobId) return;
            if (message.ok && typeof message.output === 'string') finish(null, message.output);
            else finish(new Error(message.error || 'The obfuscation engine could not process this script.'));
        });
        worker.addEventListener('error', event => {
            finish(new Error(event.message || 'The obfuscation worker could not start.'));
        }, { once: true });
        worker.addEventListener('messageerror', () => {
            finish(new Error('The obfuscation worker returned data the browser could not read.'));
        }, { once: true });

        worker.postMessage({ id: jobId, source, options });
    });
}

function matchesCachedResult(source, options) {
    return lastSuccessfulObfuscation
        && lastSuccessfulObfuscation.source === source
        && lastSuccessfulObfuscation.level === options.level
        && lastSuccessfulObfuscation.tamperCheck === options.tamperCheck
        && lastSuccessfulObfuscation.expandedTransforms === options.expandedTransforms;
}

export async function obfuscateLua(source, level = 'medium', protection = {}) {
    if (typeof source !== 'string') {
        throw new Error('Paste a LuaU script before obfuscating it.');
    }

    const sourceBytes = getUtf8ByteLength(source);
    if (sourceBytes > MAX_OBFUSCATION_SOURCE_BYTES) {
        throw new Error('This script is over the 4 MiB browser obfuscation limit. Reduce its size or save it without Lua obfuscation.');
    }

    const effectiveLevel = level === 'auto' ? resolveObfuscationLevel(source, 'auto') : level;
    if (!LEVELS.has(effectiveLevel)) {
        throw new Error('Choose Auto, Fast, Low, Medium, High, or Absolute obfuscation.');
    }

    const options = {
        level: effectiveLevel,
        tamperCheck: effectiveLevel === 'absolute' || protection.tamperCheck === true,
        expandedTransforms: effectiveLevel === 'absolute'
            || (effectiveLevel !== 'fast' && protection.expandedTransforms === true)
    };

    if (matchesCachedResult(source, options)) return lastSuccessfulObfuscation.output;

    const output = await obfuscateInWorker(source, options);
    const outputBytes = getUtf8ByteLength(output);
    if (outputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) {
        throw new Error('The generated output exceeds the 32 MiB preview and download limit. Try a lower strength or reduce the source.');
    }

    if (outputBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES) {
        lastSuccessfulObfuscation = { source, ...options, output };
    } else {
        lastSuccessfulObfuscation = null;
    }
    return output;
}

export async function encodeObfuscatedCode(source) {
    if (typeof source !== 'string') throw new Error('The obfuscation engine returned an invalid script.');

    const sourceBytes = new TextEncoder().encode(source);
    if (sourceBytes.byteLength > MAX_STORED_OBFUSCATED_OUTPUT_BYTES) {
        throw new Error('This copy is ready to download, but it is over the 4 MiB vault delivery limit. Firestore and Vercel cannot store and serve this larger copy safely.');
    }

    // The generated wrapper is ASCII. Storing it directly avoids gzip's extra
    // base64 expansion, which leaves more room under Firestore's document cap.
    const identityEligible = sourceBytes.byteLength <= MAX_STORED_ENCODED_OBFUSCATED_BYTES
        && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(source);
    const encoded = await encodeGzipBase64(source, sourceBytes);
    const encodedBytes = getUtf8ByteLength(encoded.value);
    if (identityEligible && sourceBytes.byteLength <= encodedBytes) {
        return { encoding: 'identity', value: source };
    }
    if (encodedBytes > MAX_STORED_ENCODED_OBFUSCATED_BYTES) {
        throw new Error('This execution copy is too large to store in a vault. Choose Fast or Medium to reduce its size and runtime cost, or download the generated preview.');
    }
    return encoded;
}

export async function encodeVaultSource(source) {
    if (typeof source !== 'string') throw new Error('The source script is invalid.');
    const sourceBytes = new TextEncoder().encode(source);
    if (sourceBytes.byteLength > MAX_VAULT_SOURCE_BYTES) {
        throw new Error('This script is over the 2 MiB save limit. Reduce its size before saving.');
    }
    if (sourceBytes.byteLength <= MAX_READABLE_VAULT_SOURCE_BYTES) {
        return { encoding: 'identity', value: source };
    }
    // Compress source in Firestore so large scripts leave room for the generated
    // execution copy. The editor transparently decodes both this and old records.
    return encodeGzipBase64(source, sourceBytes);
}

export async function decodeVaultSource(value, encoding) {
    if (typeof value !== 'string') throw new Error('The saved source is unavailable.');
    if (!encoding || encoding === 'identity') return value;
    if (encoding !== 'gzip-base64') throw new Error('This vault uses an unsupported source encoding.');
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed vault source.');

    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decompressed = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
    const sourceBytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
    if (sourceBytes.byteLength > MAX_VAULT_SOURCE_BYTES) throw new Error('The saved source exceeds the 2 MiB limit.');
    return new TextDecoder().decode(sourceBytes);
}

async function encodeGzipBase64(source, sourceBytes) {
    if (typeof CompressionStream !== 'function') {
        return { encoding: 'identity', value: source };
    }
    const compressed = new Blob([sourceBytes])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    return { encoding: 'gzip-base64', value: bytesToBase64(bytes) };
}

function bytesToBase64(bytes) {
    if (typeof btoa !== 'function') throw new Error('This browser cannot encode the generated script for storage.');

    // Keep temporary binary strings small while still producing one valid Base64 value.
    const chunkSize = 0x6000; // Divisible by 3, so only the final chunk can contain padding.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const binary = String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        chunks.push(btoa(binary));
    }
    return chunks.join('');
}
