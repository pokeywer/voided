import { obfuscateVaultSource } from './lua-vault.js';

self.onmessage = event => {
    const message = event.data || {};
    if (!message.id) return;
    try {
        const output = obfuscateVaultSource(message.source, message.options || {});
        self.postMessage({ id: message.id, ok: true, output });
    } catch (error) {
        self.postMessage({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};
