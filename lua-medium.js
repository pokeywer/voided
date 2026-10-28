import { armorVoidedxSource, ARMOR_LEVELS } from './lua-voidedx-armor.js';

let nextJobId = 0;
let lastSuccessfulObfuscation = null;

// Keep Auto's two-layer mode for tiny scripts; larger sources fall back to the
// single-layer Low profile to reduce runtime and vault-size overhead.
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

// Low and Medium no longer use the Weak preset: after the Prometheus pass the
// copy is repacked by the VoidedX armor, so the smallest preset is reserved for
// Fast only. Every level stays at a single VM layer: the bundled VM corrupts a
// fraction of programs once a second Vmify wraps the first VM's own bytecode
// (wrong string slots, nil index, silent early return), and every interpreter
// we test disagrees about which programs break. High and Absolute get their
// extra weight from the Strong preset and the heavier armor levels instead.
const PRESETS = Object.freeze({ fast: 'Weak', low: 'Medium', medium: 'Medium', high: 'Strong', absolute: 'Strong' });
const VM_LAYER_COUNTS = Object.freeze({ fast: 1, low: 1, medium: 1, high: 1, absolute: 1 });
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
    return getUtf8ByteLength(source) > AUTO_HIGH_BYTE_THRESHOLD ? 'low' : 'high';
}

// ---------------------------------------------------------------------------
// patchObfuscatedLengthOps
//
// Prometheus emits bare `#expr` length operators in its VM decoder and
// ConstantArray rotation code. On executors that return userdata objects
// instead of plain Lua strings/tables (some Synapse X builds, Delta, Wave,
// etc.) those ops crash with "attempt to get length of a userdata value".
//
// We post-process the obfuscated output with a proper Lua tokenizer that
// skips all string literals, long strings, and comments, then rewrites every
// `#` that appears in actual code to a safe function call.
//
// The shim avoids rawlen (not always available) and never uses # itself —
// it uses string.len for strings and a next() counter for tables.
// ---------------------------------------------------------------------------
function patchObfuscatedLengthOps(code) {
    if (typeof code !== 'string' || !code.includes('#')) return code;

    // Safe length shim — zero bare # operators outside the protected attempt.
    // The first branch keeps native # semantics, including __len on userdata
    // (the Strong VM stores its tables behind proxies). Only when # raises do we
    // fall back to string.len / next counting, which is the executor case this
    // patch exists for.
    const SHIM =
        'local __vxL;do ' +
        'local _sl=string.len;' +
        'local _tp=type;' +
        'local _pc=pcall;' +
        'local _ln=function(v) return #v end;' +
        '__vxL=function(v)' +
            'local ok,n=_pc(_ln,v);' +
            'if ok and _tp(n)=="number" then return n end;' +
            'local t=_tp(v);' +
            'if t=="string" then return _sl(v) end;' +
            'if t=="table" then local c=0;for _ in next,v do c=c+1 end;return c end;' +
            'local ok2,s=_pc(tostring,v);' +
            'if ok2 and _tp(s)=="string" then return _sl(s) end;' +
            'return 0;' +
        'end ' +
        'end;';

    const out = [];
    let i = 0;
    let patched = false;
    const n = code.length;

    while (i < n) {
        const c = code[i];

        // ── Lua long string / long comment  [=*[...]=*]  ──────────────────
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

        // ── Short quoted string  '...' or "..."  ──────────────────────────
        if (c === '"' || c === "'") {
            const q = c;
            let j = i + 1;
            while (j < n) {
                if (code[j] === '\\') { j += 2; continue; }
                if (code[j] === q) { j++; break; }
                if (code[j] === '\n' || code[j] === '\r') break;
                j++;
            }
            out.push(code.slice(i, j));
            i = j;
            continue;
        }

        // ── Comment  --  ───────────────────────────────────────────────────
        if (c === '-' && i + 1 < n && code[i + 1] === '-') {
            let j = i + 2;
            if (j < n && code[j] === '[') {
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
            const nl = code.indexOf('\n', j);
            if (nl === -1) { out.push(code.slice(i)); i = n; }
            else { out.push(code.slice(i, nl + 1)); i = nl + 1; }
            continue;
        }

        // ── # in code position ─────────────────────────────────────────────
        if (c === '#') {
            let j = i + 1;
            if (j < n && code[j] === '(') {
                let depth = 1;
                j++;
                while (j < n && depth > 0) {
                    if (code[j] === '(') depth++;
                    else if (code[j] === ')') depth--;
                    j++;
                }
                const inner = code.slice(i + 2, j - 1);
                out.push(`__vxL(${inner})`);
                i = j; patched = true; continue;
            }
            if (j < n && /[A-Za-z_]/.test(code[j])) {
                while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
                const ident = code.slice(i + 1, j);
                out.push(`__vxL(${ident})`);
                i = j; patched = true; continue;
            }
            out.push(c); i++; continue;
        }

        out.push(c); i++;
    }

    if (!patched) return code;
    return SHIM + out.join('');
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
                : 'Obfuscation timed out. Large scripts can take several minutes; try Medium strength or reduce the script size.')), timeoutMs);
            worker.addEventListener('message', event => {
                const message = event.data;
                if (!message || message.id !== jobId || message.type !== 'result') return;
                if (message.result && message.result.ok && typeof message.result.output === 'string') {
                    try {
                        const intermediateBytes = getUtf8ByteLength(message.result.output);
                        if (intermediateBytes > MAX_PROMETHEUS_OUTPUT_BYTES) {
                            throw new Error('The obfuscator produced more than 32 MiB. Try a lower strength or a smaller source.');
                        }
                        // Patch the Prometheus-generated output to fix "attempt to get length of a
                        // userdata value" crashes on executors whose table/string APIs return userdata
                        // objects. The ConstantArray VM decoder emits bare `#VAR` length ops; we
                        // prepend a tiny rawlen-or-select shim and rewrite those ops to use it.
                        const patched = patchObfuscatedLengthOps(message.result.output);
                        // Repack the Prometheus copy inside the VoidedX container so the delivered
                        // script no longer carries Prometheus shapes (watermark statement, helper
                        // names, plain `loadstring`-free layout). The inner VM is unchanged.
                        const armorLevel = ARMOR_LEVELS.includes(level) ? level : 'medium';
                        const output = armorVoidedxSource(patched, { level: armorLevel });
                        const outputBytes = getUtf8ByteLength(output);
                        if (outputBytes > MAX_OBFUSCATED_OUTPUT_BYTES) {
                            throw new Error('The generated output exceeds the 32 MiB preview and download limit. Try fewer layers or reduce the source.');
                        }
                        finish(null, output, outputBytes);
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                } else {
                    finish(new Error(message.result?.error || 'The obfuscator could not process this script.'));
                }
            });
            worker.addEventListener('error', event => {
                finish(new Error(event.message || 'The obfuscation worker could not start.'));
            }, { once: true });
            worker.addEventListener('messageerror', () => {
                finish(new Error('The obfuscation worker returned data the browser could not read.'));
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
    if (typeof source !== 'string') throw new Error('The obfuscator returned an invalid script.');

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

