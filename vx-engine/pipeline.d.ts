import type { IntegrityFail, IntegrityMode } from "./envelope.js";
import type { EnvCheckOptions } from "./envchecks.js";
import type { Chunk } from "./ast/types.js";
export type VxMode = "ast" | "vm" | "reg";
export type VxLevel = "debug" | "normal" | "max";
export type VxPreset = "light" | "standard" | "strong" | "max" | "ultra" | "reg";
export interface VxOptions {
    mode?: VxMode;
    level?: "debug" | "normal" | "max";
    preset?: VxPreset;
    seed?: number;
    nesting?: number;
    compression?: boolean;
    renameLocals?: boolean;
    preserveGlobals?: boolean;
    encodeStrings?: boolean;
    scramble?: boolean;
    banner?: boolean;
    disableFeatures?: string[];
    forceFeatures?: string[];
    env?: EnvCheckOptions | false;
    integrity?: IntegrityMode;
    integrityFail?: IntegrityFail;
    integrityCopies?: number;
    integrityProbes?: number;
}
export interface VxStats {
    mode: VxMode;
    level: "debug" | "normal" | "max";
    preset?: VxPreset;
    seed: number;
    inputChars: number;
    outputChars: number;
    ratio: number;
    constants: number;
    protos: number;
    instructions: number;
    envChecks: string[];
    repair: string;
    repaired: number;
    integrity: string;
    elapsedMs: number;
}
export interface VxResult {
    code: string;
    stats: VxStats;
}
export declare function parseLuauSource(source: string): Chunk;
export declare function applyEnvChecks(ast: Chunk, options: EnvCheckOptions): {
    ast: Chunk;
    checks: string[];
};
export declare function obfuscateLuau(source: string, options?: VxOptions): VxResult;
//# sourceMappingURL=pipeline.d.ts.map