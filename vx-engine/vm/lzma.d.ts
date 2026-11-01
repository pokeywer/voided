export declare function base85Encode(data: Uint8Array): string;
export declare function base85Decode(str: string): Uint8Array;
/**
 * The S-Box and keystream are not stored in the output at all: both sides regenerate them from a
 * 32-bit seed with this LCG, so there is no 256-entry table left to grep out of a shipped file.
 * Every step stays below 2^53 so doubles and Luau numbers agree exactly; the call order
 * (key length, then shuffle, then keystream) must match the emitted Luau.
 */
export declare const LCG_MUL = 1664525;
export declare const LCG_ADD = 1013904223;
export declare const LCG_MOD = 4294967296;
export interface DerivedKeys {
    keyLen: number;
    sbox: number[];
    invSbox: number[];
    xorKey: number[];
}
export declare function deriveKeys(seed: number): DerivedKeys;
export interface VxBlob {
    blob: string;
    xorKey: number[];
    invSbox: number[];
    checksum: number;
    origLen: number;
    seed: number;
    keyLen: number;
}
export declare function encryptAndEncode(input: string, rng: () => number): VxBlob;
export declare function compressToBase85(input: string): string;
export declare function compressBytesToBase85(input: Uint8Array): string;
export declare function compress(input: Uint8Array): Uint8Array;
export declare function decompress(input: Uint8Array): Uint8Array;
//# sourceMappingURL=lzma.d.ts.map