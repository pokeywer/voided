import type { Chunk } from "../ast/types.js";
export interface StringEncoderOptions {
    key?: number;
    enabled?: boolean;
}
export declare function encodeStrings(ast: Chunk, options?: StringEncoderOptions): Chunk;
//# sourceMappingURL=StringEncoder.d.ts.map