import type { BytecodeChunk, Constant } from "./bytecode.js";
export interface VMRunnerEnv {
    [key: string]: unknown;
}
export interface VMRunnerOptions {
    onTick?: () => void;
    tickInterval?: number;
}
export declare function runVM(K: Constant[], code: number[], env: VMRunnerEnv, key?: number, protos?: BytecodeChunk[], initLocals?: Record<number, unknown>, upvalues?: {
    [idx: number]: {
        0: unknown;
    };
}, varargs?: unknown[], options?: VMRunnerOptions): unknown;
//# sourceMappingURL=vm-runner.d.ts.map