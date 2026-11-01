import type { BytecodeChunk } from "./bytecode.js";
export type VMGenLevel = "debug" | "normal" | "max";
export type FeatureFlag = "fakeHandlers" | "opaquePredicates" | "cff" | "handlerMutation" | "handlerNoise" | "antiDebug" | "antiTamper" | "superOperators" | "constantFolding" | "minification" | "stringFragment" | "lazyDecode" | "nopCamouflage" | "contextOpcodes" | "nonLinearJumps" | "antiHookDeep" | "antiDump" | "sandboxDetect" | "cfi" | "runtimeMonitor" | "stringMutation" | "adaptiveFragments" | "stackPooling";
export interface VMGenOptions {
    level?: VMGenLevel;
    executorGlobals?: boolean;
    nesting?: number;
    vmId?: string;
    polymorphicSeed?: number;
    disableFeatures?: FeatureFlag[];
    forceSingleVM?: boolean;
    forceNestedVM?: boolean;
    _noWatermark?: boolean;
    forceFeatures?: FeatureFlag[];
    noCompression?: boolean;
}
export declare function generateVM(chunk: BytecodeChunk, options?: VMGenOptions): string;
//# sourceMappingURL=vm-gen.d.ts.map