export function emit(chunk, op, ...args) {
    chunk.code.push(op);
    for (const arg of args)
        chunk.code.push(arg);
}
export function addConst(chunk, value) {
    const i = chunk.K.indexOf(value);
    if (i >= 0)
        return i;
    chunk.K.push(value);
    return chunk.K.length - 1;
}
export const RK_OFFSET = 256;
export function RK(kIndex) {
    return kIndex + RK_OFFSET;
}
export function isRK_K(rk) {
    return rk >= RK_OFFSET;
}
export function rkToK(rk) {
    return rk - RK_OFFSET;
}
export const REG_OPCODE_COUNT = 57;
export function regEmit(chunk, op, A = 0, B = 0, C = 0) {
    const pos = chunk.code.length;
    chunk.code.push(op, A, B, C);
    chunk.nInstructions++;
    if (A >= 0 && A < RK_OFFSET)
        chunk.maxRegs = Math.max(chunk.maxRegs, A + 1);
    if (B >= 0 && B < RK_OFFSET)
        chunk.maxRegs = Math.max(chunk.maxRegs, B + 1);
    if (C >= 0 && C < RK_OFFSET)
        chunk.maxRegs = Math.max(chunk.maxRegs, C + 1);
    return pos;
}
export function regPatch(chunk, pos, field, value) {
    const offset = field === 'op' ? 0 : field === 'A' ? 1 : field === 'B' ? 2 : 3;
    chunk.code[pos + offset] = value;
}
export function regPC(chunk) {
    return chunk.nInstructions;
}
export function regAddConst(chunk, value) {
    const i = chunk.K.indexOf(value);
    if (i >= 0)
        return i;
    chunk.K.push(value);
    return chunk.K.length - 1;
}
export function createRegChunk() {
    return {
        K: [],
        code: [],
        nInstructions: 0,
        maxRegs: 0,
        nParams: 0,
        isVararg: false,
    };
}
export function regAddProto(parent, proto) {
    if (!parent.protos)
        parent.protos = [];
    parent.protos.push(proto);
    return parent.protos.length - 1;
}
//# sourceMappingURL=bytecode.js.map