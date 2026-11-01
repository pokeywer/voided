import type { RegBytecodeChunk } from "./bytecode.js";
export type RegVMLevel = "debug" | "normal" | "max";
export type RegFeatureFlag = "opcodeShuffle" | "stringEncoding" | "constantFolding" | "minification" | "fakeHandlers" | "handlerNoise" | "antiDebug" | "antiTamper" | "controlFlowFlattening" | "opcodeFusion" | "deadCodeInjection" | "syntaxInterpreter" | "customCipher" | "stubCompression" | "vmNesting";
export interface RegVMGenOptions {
    level?: RegVMLevel;
    executorGlobals?: boolean;
    polymorphicSeed?: number;
    disableFeatures?: RegFeatureFlag[];
    forceFeatures?: RegFeatureFlag[];
    debugTrace?: boolean;
    _noWatermark?: boolean;
    target?: string;
}
export declare function generateRegVM(chunk: RegBytecodeChunk, options?: RegVMGenOptions): string;
//# sourceMappingURL=reg-vm-gen.d.ts.map