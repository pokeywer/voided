export type Constant = null | boolean | number | string;
export interface BytecodeChunk {
    K: Constant[];
    code: number[];
    protos?: BytecodeChunk[];
    upvalues?: [number, number][];
}
export declare const enum Op {
    NOP = 0,
    PUSH_NIL = 1,
    PUSH_TRUE = 2,
    PUSH_FALSE = 3,
    PUSH_K = 4,
    LOAD_L = 5,
    STORE_L = 6,
    LOAD_G = 7,
    STORE_G = 8,
    ADD = 9,
    SUB = 10,
    MUL = 11,
    DIV = 12,
    MOD = 13,
    POW = 14,
    CONCAT = 15,
    EQ = 16,
    NE = 17,
    LT = 18,
    LE = 19,
    GT = 20,
    GE = 21,
    AND = 22,
    OR = 23,
    NOT = 24,
    UNM = 25,
    LEN = 26,
    NEW_TABLE = 27,
    GET_TABLE = 28,
    SET_TABLE = 29,
    CALL = 30,
    RETURN = 31,
    JMP = 32,
    JMP_F = 33,
    POP = 34,
    CLOSURE = 35,
    DUP = 36,
    LOAD_UPVAL = 37,
    STORE_UPVAL = 38,
    CALL_MULTI = 39,
    LOAD_VARARG = 40,
    TAILCALL = 41,
    FORPREP = 42,
    FORLOOP = 43,
    CONCAT_MULTI = 44,
    PUSH_NILS = 45,
    MARK = 46,
    CALL_DYNAMIC = 47,
    IDIV = 48,
    CLOSE_UPVAL = 49,
    SETLIST = 50,
    SWAP = 51,
    NAMECALL = 52,
    TFOR = 53,
    PCALL = 54,
    XPCALL = 55,
    ITER_PREP = 56
}
export declare function emit(chunk: BytecodeChunk, op: Op, ...args: number[]): void;
export declare function addConst(chunk: BytecodeChunk, value: Constant): number;
export declare const RK_OFFSET = 256;
export declare function RK(kIndex: number): number;
export declare function isRK_K(rk: number): boolean;
export declare function rkToK(rk: number): number;
export declare const enum RegOp {
    NOP = 0,
    LOADK = 1,
    LOADNIL = 2,
    LOADBOOL = 3,
    MOVE = 4,
    GETGLOBAL = 5,
    SETGLOBAL = 6,
    GETTABLE = 7,
    SETTABLE = 8,
    NEWTABLE = 9,
    ADD = 10,
    SUB = 11,
    MUL = 12,
    DIV = 13,
    MOD = 14,
    POW = 15,
    IDIV = 16,
    UNM = 17,
    NOT = 18,
    LEN = 19,
    CONCAT = 20,
    JMP = 21,
    EQ = 22,
    LT = 23,
    LE = 24,
    TEST = 25,
    TESTSET = 26,
    CALL = 27,
    TAILCALL = 28,
    RETURN = 29,
    FORPREP = 30,
    FORLOOP = 31,
    TFORLOOP = 32,
    SETLIST = 33,
    CLOSURE = 34,
    VARARG = 35,
    SELF = 36,
    GETUPVAL = 37,
    SETUPVAL = 38,
    CLOSEUPVAL = 39,
    PCALL = 40,
    XPCALL = 41,
    ITERPREP = 42,
    LOADKX = 43,
    EXTRAARG = 44,
    FUSED_TEST_JMP = 45,
    FUSED_EQ_JMP = 46,
    FUSED_LT_JMP = 47,
    FUSED_LE_JMP = 48,
    FUSED_TESTSET_JMP = 49,
    FUSED_GGET = 50,
    FUSED_LOADKK = 51,
    FUSED_MOVE_MOVE = 52,
    FUSED_SELF_CALL = 53,
    FUSED_GGET_CALL = 54,
    FUSED_LOADK_RET = 55,
    FUSED_MOVE_RET = 56
}
export declare const REG_OPCODE_COUNT = 57;
export interface RegInstruction {
    op: RegOp;
    A: number;
    B: number;
    C: number;
}
export interface RegBytecodeChunk {
    K: Constant[];
    code: number[];
    nInstructions: number;
    maxRegs: number;
    nParams: number;
    isVararg: boolean;
    protos?: RegBytecodeChunk[];
    upvalues?: [number, number][];
}
export declare function regEmit(chunk: RegBytecodeChunk, op: RegOp, A?: number, B?: number, C?: number): number;
export declare function regPatch(chunk: RegBytecodeChunk, pos: number, field: 'op' | 'A' | 'B' | 'C', value: number): void;
export declare function regPC(chunk: RegBytecodeChunk): number;
export declare function regAddConst(chunk: RegBytecodeChunk, value: Constant): number;
export declare function createRegChunk(): RegBytecodeChunk;
export declare function regAddProto(parent: RegBytecodeChunk, proto: RegBytecodeChunk): number;
//# sourceMappingURL=bytecode.d.ts.map