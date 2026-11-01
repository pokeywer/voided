import type { Chunk } from "../ast/types.js";
export interface ControlFlowScramblerOptions {
    seed?: number;
    enabled?: boolean;
}
export declare function scrambleControlFlow(ast: Chunk, options?: ControlFlowScramblerOptions): Chunk;
//# sourceMappingURL=ControlFlowScrambler.d.ts.map