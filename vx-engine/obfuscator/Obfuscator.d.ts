import type { Chunk } from "../ast/types.js";
export interface ObfuscatorOptions {
    renameLocals?: boolean;
    preserveGlobals?: boolean;
    seed?: number;
}
export declare function obfuscate(ast: Chunk, options?: ObfuscatorOptions): Chunk;
//# sourceMappingURL=Obfuscator.d.ts.map