import { lex } from "./lexer/Lexer.js";
import { parseWithErrors } from "./parser/Parser.js";
import { obfuscate } from "./obfuscator/Obfuscator.js";
import { encodeStrings } from "./obfuscator/StringEncoder.js";
import { scrambleControlFlow } from "./obfuscator/ControlFlowScrambler.js";
import { printChunk } from "./obfuscator/Printer.js";
import { compile } from "./vm/Compiler.js";
import { generateVM } from "./vm/vm-gen.js";
import { regCompile } from "./vm/RegCompiler.js";
import { generateRegVM } from "./vm/reg-vm-gen.js";
import { buildEnvChecks } from "./envchecks.js";
import { repairTopLevelOrder } from "./repair.js";
import { wrapWithIntegrity } from "./envelope.js";
const ALL_REG_FEATURES = [
    "opcodeShuffle", "stringEncoding", "constantFolding", "minification", "fakeHandlers",
    "handlerNoise", "antiDebug", "antiTamper", "controlFlowFlattening", "opcodeFusion",
    "deadCodeInjection", "syntaxInterpreter", "customCipher", "stubCompression", "vmNesting",
];
/**
 * Verified against luau.exe: light/standard/strong/max all execute the corpus byte-identically.
 * The stack VM at level "max" is reachable via --mode vm --level max but its cipher/nested layers
 * corrupt the payload on most seeds, so it is not a preset.
 */
const PRESETS = {
    light: { mode: "ast", level: "normal", nesting: 0, compression: false, forceFeatures: [], integrity: "off", integrityCopies: 1, integrityProbes: 0 },
    standard: { mode: "vm", level: "normal", nesting: 0, compression: true, forceFeatures: [], integrity: "off", integrityCopies: 1, integrityProbes: 0 },
    strong: { mode: "reg", level: "max", nesting: 0, compression: true, forceFeatures: [], integrity: "mirror", integrityCopies: 2, integrityProbes: 3 },
    max: {
        mode: "reg",
        level: "max",
        nesting: 0,
        compression: true,
        forceFeatures: [],
        envDefaults: { host: "roblox-or-executor", strictInstances: true },
        integrity: "mirror",
        integrityCopies: 2,
        integrityProbes: 3,
    },
    ultra: {
        mode: "reg",
        level: "max",
        nesting: 0,
        compression: true,
        forceFeatures: ALL_REG_FEATURES,
        envDefaults: { host: "roblox-or-executor", strictInstances: true },
        integrity: "mirror",
        integrityCopies: 8,
        integrityProbes: 6,
    },
    reg: { mode: "reg", level: "max", nesting: 0, compression: true, forceFeatures: [], integrity: "mirror", integrityCopies: 2, integrityProbes: 3 },
};
const TYPE_DECL = new Set(["TypeStatement", "ExportTypeStatement"]);
export function parseLuauSource(source) {
    const { tokens, errors } = lex(source);
    if (errors.length > 0) {
        const first = errors[0];
        throw new Error(`lex error at line ${first.loc?.start?.line ?? "?"}: ${first.message ?? JSON.stringify(first)}`);
    }
    const { ast, errors: parseErrors } = parseWithErrors(tokens);
    if (parseErrors.length > 0) {
        const first = parseErrors[0];
        throw new Error(`parse error at line ${first.loc?.start?.line ?? "?"}: ${first.message} (${parseErrors.length} error(s); refusing to emit partial output)`);
    }
    return ast;
}
export function applyEnvChecks(ast, options) {
    const built = buildEnvChecks(options);
    const guard = parseLuauSource(built.source);
    const ifNode = guard.body[guard.body.length - 1];
    if (!ifNode || ifNode.type !== "IfStatement") {
        throw new Error("env-check template did not end in an if statement");
    }
    const hoisted = ast.body.filter((s) => TYPE_DECL.has(s.type));
    const inner = ast.body.filter((s) => !TYPE_DECL.has(s.type));
    ifNode.thenBody = inner;
    return { ast: { ...ast, body: [...hoisted, ...guard.body] }, checks: built.checks };
}
function definedOnly(value) {
    const out = {};
    for (const [key, entry] of Object.entries(value ?? {})) {
        if (entry !== undefined)
            out[key] = entry;
    }
    return out;
}
function pickPreset(options) {
    const base = options.preset ? PRESETS[options.preset] : PRESETS.ultra;
    const mode = options.mode ?? base.mode;
    const level = options.level ?? base.level;
    return {
        mode,
        level,
        nesting: options.nesting ?? base.nesting,
        compression: options.compression !== undefined ? options.compression : base.compression,
        forceFeatures: options.forceFeatures ?? [],
        envDefaults: base.envDefaults,
        integrity: options.integrity ?? base.integrity,
        integrityCopies: options.integrityCopies ?? base.integrityCopies,
        integrityProbes: options.integrityProbes ?? base.integrityProbes,
    };
}
export function obfuscateLuau(source, options = {}) {
    const started = Date.now();
    const preset = pickPreset(options);
    const seed = options.seed ?? ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    let ast = parseLuauSource(source);
    if (options.encodeStrings && preset.mode === "ast") {
        ast = encodeStrings(ast, { enabled: true, key: seed & 0xff });
    }
    if (options.scramble && preset.mode === "ast") {
        ast = scrambleControlFlow(ast, { enabled: true, seed });
    }
    let checks = [];
    if (options.env !== false) {
        const envOptions = { ...(preset.envDefaults ?? {}), ...definedOnly(options.env) };
        const applied = applyEnvChecks(ast, { ...envOptions, seed });
        ast = applied.ast;
        checks = applied.checks;
    }
    const renamed = obfuscate(ast, {
        renameLocals: options.renameLocals !== false,
        preserveGlobals: options.preserveGlobals !== false,
        seed,
    });
    let code;
    let constants = 0;
    let protos = 0;
    let instructions = 0;
    if (preset.mode === "ast") {
        code = printChunk(renamed);
    }
    else if (preset.mode === "reg") {
        const chunk = regCompile(renamed);
        constants = chunk.K.length;
        protos = (chunk.protos ?? []).length;
        instructions = chunk.code.length / 4;
        code = generateRegVM(chunk, {
            level: preset.level,
            executorGlobals: preset.level !== "debug",
            polymorphicSeed: seed,
            disableFeatures: (options.disableFeatures ?? []),
            forceFeatures: (options.forceFeatures ?? []),
            _noWatermark: options.banner === false,
        });
    }
    else {
        const chunk = compile(renamed);
        constants = chunk.K.length;
        protos = (chunk.protos ?? []).length;
        instructions = chunk.code.length;
        code = generateVM(chunk, {
            level: preset.level,
            executorGlobals: preset.level !== "debug",
            nesting: preset.nesting,
            polymorphicSeed: seed,
            noCompression: !preset.compression,
            disableFeatures: (options.disableFeatures ?? []),
            forceFeatures: (options.forceFeatures ?? preset.forceFeatures),
            _noWatermark: options.banner === false,
        });
    }
    const repaired = preset.mode === "ast" ? { code, moved: 0, note: "not applicable" } : repairTopLevelOrder(code);
    const enveloped = wrapWithIntegrity(repaired.code, {
        mode: preset.integrity,
        failMode: options.integrityFail ?? "error",
        seed,
        copies: preset.integrityCopies,
        probes: preset.integrityProbes,
    });
    const finalCode = enveloped.code;
    return {
        code: finalCode,
        stats: {
            mode: preset.mode,
            level: preset.level,
            preset: options.preset,
            seed,
            inputChars: source.length,
            outputChars: finalCode.length,
            ratio: source.length > 0 ? finalCode.length / source.length : 0,
            constants,
            protos,
            instructions,
            envChecks: checks,
            repair: repaired.note,
            repaired: repaired.moved,
            integrity: preset.integrity === "off" ? "off" : `${preset.integrity} x${enveloped.copies} copy(ies)`,
            elapsedMs: Date.now() - started,
        },
    };
}
//# sourceMappingURL=pipeline.js.map