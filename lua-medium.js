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

const PRESETS = Object.freeze({ fast: 'Weak', low: 'Weak', medium: 'Medium', high: 'Strong', absolute: 'Strong' });
const VM_LAYER_COUNTS = Object.freeze({ fast: 1, low: 1, medium: 1, high: 2, absolute: 2 });
const MIN_JOB_TIMEOUT_MS = 120_000;
const MAX_JOB_TIMEOUT_MS = 900_000;
const MAX_PROMETHEUS_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_STORED_ENCODED_OBFUSCATED_BYTES = 920 * 1024;

export function getUtf8ByteLength(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return new TextEncoder().encode(text).byteLength;
}

export function resolveObfuscationLevel(source, requestedLevel = 'auto') {
    if (Object.hasOwn(PRESETS, requestedLevel)) return requestedLevel;
    return getUtf8ByteLength(source) > AUTO_HIGH_BYTE_THRESHOLD ? 'medium' : 'high';
}

// Prometheus's ConstantArray and VM steps emit bare `#x` length ops. On executors
// that return userdata from readfile() or crypt APIs, those ops crash with
// "attempt to get length of a userdata value". This shim prepends a safe length
// helper and rewrites `#IDENT` patterns inside the generated output to use it.
// We only touch identifiers (word chars) — not string literals or expressions.
function patchObfuscatedLengthOps(code) {
    if (typeof code !== 'string' || !code.includes('#')) return code;
    // The shim: use rawlen for tables, #tostring for strings, 0 for anything else.
    const shim = `local __vx_len=rawlen or function(v) local t=type(v) if t=="string" then return #tostring(v) elseif t=="table" then local n=0 for _ in pairs(v) do n=n+1 end return n end return 0 end;`;
    // Replace `#IDENTIFIER` (but not inside string literals or comments) with the shim call.
    // This regex matches # followed by a Lua identifier that isn't already inside a string.
    // We do a simple token-aware pass: skip long strings, quoted strings, and comments.
    let result = '';
    let i = 0;
    let patched = false;
    while (i < code.length) {
        const ch = code[i];
        // Skip Lua long strings [==[...]==]
        if (ch === '[') {
            const lb = code.indexOf('[', i + 1);
            if (lb !== -1) {
                let eqCount = 0;
                let j = i + 1;
                while (code[j] === '=') { eqCount++; j++; }
                if (code[j] === '[') {
                    const close = `]${'='.repeat(eqCount)}]`;
                    const end = code.indexOf(close, j + 1);
                    if (end !== -1) {
                        result += code.slice(i, end + close.length);
                        i = end + close.length;
                        continue;
                    }
                }
            }
        }
        // Skip single-quoted strings
        if (ch === "'" || ch === '"') {
            const q = ch;
            result += q;
            i++;
            while (i < code.length && code[i] !== q) {
                if (code[i] === '\\') { result += code[i]; i++; }
                result += code[i] || '';
                i++;
            }
            if (i < code.length) { result += code[i]; i++; }
            continue;
        }
        // Skip line comments
        if (ch === '-' && code[i + 1] === '-') {
            const nl = code.indexOf('\n', i);
            result += nl !== -1 ? code.slice(i, nl + 1) : code.slice(i);
            i = nl !== -1 ? nl + 1 : code.length;
            continue;
        }
        // Rewrite #IDENTIFIER
        if (ch === '#') {
            const rest = code.slice(i + 1);
            const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) {
                result += `__vx_len(${m[1]})`;
                i += 1 + m[1].length;
                patched = true;
                continue;
            }
        }
        result += ch;
        i++;
    }
    return patched ? shim + result : code;
}

export function obfuscateLua(source, level = 'medium', protection = {}) {
    if (typeof source !== 'string') {
        return Promise.reject(new Error('Paste a LuaU script before obfuscating it.'));
    }

    const sourceBytes = getUtf8ByteLength(source);
    if (sourceBytes > MAX_OBFUSCATION_SOURCE_BYTES) {
        return Promise.reject(new Error('This script is over the 4 MiB browser obfuscation limit. Reduce its size or save it without Lua obfuscation.'));
    }

    const preset = PRESETS[level];
    if (!preset) return Promise.reject(new Error('Choose Auto, Fast, Low, Medium, High, or Absolute obfuscation.'));

    const absoluteMode = level === 'absolute';
    const fastMode = level === 'fast';
    const tamperCheck = absoluteMode || protection.tamperCheck === true;
    // Every obfuscated output now goes through the VM pipeline. The two-layer
    // ceiling limits runtime overhead and keeps larger copies vault-friendly.
    const vmProtection = true;
    const expandedTransforms = absoluteMode || (!fastMode && protection.expandedTransforms === true);
    const vmLayers = VM_LAYER_COUNTS[level] || 1;
    if (lastSuccessfulObfuscation?.source === source
        && lastSuccessfulObfuscation.level === level
        && lastSuccessfulObfuscation.tamperCheck === tamperCheck
        && lastSuccessfulObfuscation.vmProtection === vmProtection
        && lastSuccessfulObfuscation.expandedTransforms === expandedTransforms
        && lastSuccessfulObfuscation.fastMode === fastMode
        && lastSuccessfulObfuscation.vmLayers === vmLayers) {
        return Promise.resolve(lastSuccessfulObfuscation.output);
    }

    return new Promise((resolve, reject) => {
        const workerUrl = new URL('./prometheus-engine/assets/prometheus.worker-CXYhVY6S.js', import.meta.url);
        let worker;
        let timeoutId;
        let settled = false;
        const jobId = `voidedx-${Date.now()}-${++nextJobId}`;
        const timeoutPer10KiB = absoluteMode ? 12_000 : 8_000;
        const timeoutMs = Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, Math.ceil(sourceBytes / 10_240) * timeoutPer10KiB));

        const finish = (error, output, outputBytes) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            try { worker?.terminate(); } catch {}
            if (error) {
                reject(error);
                return;
            }
            const finalBytes = Number.isFinite(outputBytes) ? outputBytes : getUtf8ByteLength(output);
            if (finalBytes <= MAX_INLINE_OBFUSCATED_PREVIEW_BYTES) {
                lastSuccessfulObfuscation = { source, level, tamperCheck, vmProtection, expandedTransforms, fastMode, vmLayers, output };
            } else {
                lastSuccessfulObfuscation = null;
            }
            resolve(output);
        };

        try {
            worker = new Worker(workerUrl, { type: 'module' });
            timeoutId = setTimeout(() => finish(new Error(absoluteMode
                ? 'Absolute obfuscation timed out. Try High strength or reduce the script size.'
                : 'Prometheus timed out. Large scripts can take several minutes; try Medium strength or reduce the script size.')), timeoutMs);
            worker.addEventListener('message', event => {
                const message = event.data;
                if (!message || message.id !== jobId || message.type !== 'result') return;
                if (message.result && message.result.ok && typeof message.result.output === 'string') {
                    try {
                        const intermediateBytes = getUtf8ByteLength(message.result.output);
                        if (intermediateBytes > MAX_PROMETHEUS_OUTPUT_BYTES) {
                            throw new Error('Prometheus produced more than 32 MiB. Try a lower strength or a smaller source.');
                        }
                        // Patch the Prometheus-generated output to fix "attempt to get length of a
                        // userdata value" crashes on executors whose table/string APIs return userdata
                        // objects. The ConstantArray VM decoder emits bare `#VAR` length ops; we
                        // prepend a tiny rawlen-or-select shim and rewrite those ops to use it.
                        const output = patchObfuscatedLengthOps(message.result.output);
                        const outputBytes = getUtf8ByteLength(output);
                        if (outputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) {
                            throw new Error('The generated output exceeds the 32 MiB preview and download limit. Try fewer layers or reduce the source.');
                        }
                        finish(null, output, outputBytes);
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                } else {
                    finish(new Error(message.result?.error || 'Prometheus could not obfuscate this script.'));
                }
            });
            worker.addEventListener('error', event => {
                finish(new Error(event.message || 'The Prometheus worker could not start.'));
            }, { once: true });
            worker.addEventListener('messageerror', () => {
                finish(new Error('The Prometheus worker returned data the browser could not read.'));
            }, { once: true });

            const seed = Math.floor(Math.random() * 2_147_483_646) + 1;
            worker.postMessage({
                id: jobId,
                action: 'obfuscate',
                options: {
                    source,
                    filename: 'vault.lua',
                    preset,
                    luaVersion: 'LuaU',
                    tamperCheck,
                    vmProtection,
                    expandedTransforms,
                    fastMode,
                    vmLayers,
                    prettyPrint: false,
                    seed
                }
            });
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export async function encodeObfuscatedCode(source) {
    if (typeof source !== 'string') throw new Error('Prometheus returned an invalid script.');

    const sourceBytes = new TextEncoder().encode(source);
    if (sourceBytes.byteLength > MAX_STORED_OBFUSCATED_OUTPUT_BYTES) {
        throw new Error('This copy is ready to download, but it is over the 4 MiB vault delivery limit. Firestore and Vercel cannot store and serve this larger copy safely.');
    }

    const encoded = await encodeGzipBase64(source, sourceBytes);
    if (getUtf8ByteLength(encoded.value) > MAX_STORED_ENCODED_OBFUSCATED_BYTES) {
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

