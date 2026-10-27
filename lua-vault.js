// VoidedX vault entry point.
//
// Historically this module held a loadstring-based wrapper. Delivery now goes
// through the bytecode VM engine (lua-vm-engine.js): the source is compiled to
// a register program, encrypted, and executed by a bundled interpreter, so the
// original text never survives in the generated file.

import { obfuscateVmSource, VM_ENGINE_VERSION } from './lua-vm-engine.js';

export const ENGINE_VERSION = VM_ENGINE_VERSION;

export function obfuscateVaultSource(source, options = {}) {
    return obfuscateVmSource(source, {
        level: options.level,
        tamperCheck: options.tamperCheck,
        expandedTransforms: options.expandedTransforms
    });
}
