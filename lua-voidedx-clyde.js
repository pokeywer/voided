import { obfuscateLuau } from './vx-engine/pipeline.js';

// The VoidedX build of the Clyde pipeline: lexer -> parser -> AST passes -> register
// VM, plus an integrity envelope of independently keyed copies, a mutated decoy and
// several differently written re-check probes. This is the engine behind a vault's
// stored copy; the VoidedX container still wraps the result for the watermark, the
// load-bearing filler tripwire and the profile stamp.
//
// Presets are ordered by cost, because a stored copy has to fit the vault document:
// the same script is about 1x at light, 3.6x at standard, 16x at strong and 161x at
// ultra, so the strongest preset that fits is chosen rather than always the biggest.
export const ENGINE_PRESETS = Object.freeze(['light', 'standard', 'strong', 'ultra']);
// Explicit opt-in only, and only from the CLI path: preset: 'ultra' on a call.

const LEVEL_PRESET = Object.freeze({
    fast: 'light',
    low: 'standard',
    medium: 'standard',
    high: 'strong',
    // absolute keeps strong's register VM but the widest envelope (5 keyed copies,
    // 6 probes). ultra is not a default: on a vararg-heavy script it emits
    // "Cannot use '...' outside of a vararg function" for some seeds, and a build
    // that only breaks on some seeds is not shippable. Ask for it by name.
    absolute: 'strong'
});

// Envelope settings follow the requested strength, not the fallback preset: more
// copies and more probes mean more independent places a patch has to agree with,
// at a linear size cost.
const LEVEL_ENVELOPE = Object.freeze({
    fast: { integrity: 'off', integrityCopies: 1, integrityProbes: 0 },
    low: { integrity: 'off', integrityCopies: 1, integrityProbes: 0 },
    medium: { integrity: 'basic', integrityCopies: 2, integrityProbes: 2 },
    high: { integrity: 'mirror', integrityCopies: 2, integrityProbes: 3 },
    absolute: { integrity: 'mirror', integrityCopies: 5, integrityProbes: 6 }
});

export function clydeObfuscate(source, level = 'medium', options = {}) {
    const envelope = LEVEL_ENVELOPE[level] || LEVEL_ENVELOPE.medium;
    const preset = options.preset && ENGINE_PRESETS.includes(options.preset)
        ? options.preset
        : (LEVEL_PRESET[level] || LEVEL_PRESET.medium);
    const settings = {
        preset,
        // Their runtime gate is off unless a caller asks: it refuses a host whose
        // `game` is not a real Instance, which denies players on unusual hosts for
        // no protection the loader does not already have.
        env: options.envChecks === true ? undefined : false,
        banner: false,
        integrity: options.integrity ?? envelope.integrity,
        integrityCopies: options.integrityCopies ?? envelope.integrityCopies,
        integrityProbes: options.integrityProbes ?? envelope.integrityProbes,
        seed: options.seed
    };
    const result = obfuscateLuau(String(source), settings);
    const code = typeof result?.code === 'string' ? result.code : '';
    if (!code.trim()) throw new Error('The obfuscation engine returned an empty script.');
    return { code, stats: result.stats || {}, preset, integrity: settings.integrity };
}

// Strongest preset whose output still fits what the caller can store, stepping down
// one rung at a time. With no budget the requested preset is used as-is.
export function clydeObfuscateWithinBudget(source, level = 'medium', options = {}) {
    const budget = Number(options.budgetBytes) > 0 ? Math.floor(Number(options.budgetBytes)) : 0;
    let start = ENGINE_PRESETS.indexOf(LEVEL_PRESET[level] || LEVEL_PRESET.medium);
    if (!budget) {
        return clydeObfuscate(source, level, options);
    }
    let smallest = null;
    for (let index = start; index >= 0; index -= 1) {
        const built = clydeObfuscate(source, level, { ...options, preset: ENGINE_PRESETS[index] });
        smallest = built;
        if (built.code.length <= budget) return built;
    }
    return smallest;
}
