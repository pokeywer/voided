import { gunzipSync } from 'node:zlib';

const MAX_VAULT_SOURCE_BYTES = 2 * 1024 * 1024;

export function getSourceForEditor(vaultData) {
    const storedSource = typeof vaultData.code === 'string' ? vaultData.code : '';
    if (vaultData.codeEncoding === 'gzip-base64') {
        return gunzipSync(Buffer.from(storedSource, 'base64'), { maxOutputLength: MAX_VAULT_SOURCE_BYTES }).toString('utf8');
    }
    if (vaultData.codeEncoding === 'identity') return storedSource;
    // Older vaults store readable source directly in `code`.
    return storedSource;
}

function decodeObfuscatedCopy(vaultData, stored) {
    if (vaultData.obfuscatedCodeEncoding === 'gzip-base64') {
        return gunzipSync(Buffer.from(stored, 'base64'), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8');
    }
    // Identity, and older records that carry no encoding field, store the
    // generated copy as plain text.
    return stored;
}

/**
 * The copy that is actually delivered and run.
 *
 * A vault the owner saved with obfuscation on must never fall back to the
 * readable source: that silently turns "protected" vaults into plain-source
 * vaults for anyone who runs the loader. When such a vault has no usable
 * execution copy this returns null and the caller refuses the launch, so the
 * owner is told to re-save instead of leaking the source.
 *
 * Vaults saved with obfuscation off (or from before the feature existed) keep
 * returning their source: that is a deliberate owner choice.
 */
export function getCodeForExecution(vaultData) {
    if (vaultData.obfuscationEnabled !== true) return getSourceForEditor(vaultData);

    const stored = typeof vaultData.obfuscatedCode === 'string' ? vaultData.obfuscatedCode : '';
    if (!stored) return null;

    let execution;
    try {
        execution = decodeObfuscatedCopy(vaultData, stored);
    } catch {
        return null;
    }
    if (typeof execution !== 'string' || !execution.trim()) return null;

    // An obfuscated copy that is byte-identical to the owner's source means the
    // protected build never replaced it. Serving it would hand out the source
    // under the label of a protected vault.
    try {
        if (execution === getSourceForEditor(vaultData)) return null;
    } catch {
        // An undecodable source cannot be compared; the copy itself is usable.
    }
    return execution;
}
