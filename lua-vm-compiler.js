// VoidedX VM compiler.
//
// Lowers the Luau AST produced by lua-vm-parser.js into register bytecode for
// the VoidedX interpreter. The original source never leaves this module: the
// generated script only carries an encrypted program blob, so there is no
// `loadstring` of user code for a dumper to grab.
//
// Slot numbering is 1-based (slot 1 -> frame[1]) so the runtime never has to
// rebase indices. Operands are written as A (byte), B/C (16-bit words).

import { parseLua } from './lua-vm-parser.js';

export const VM_OPS = Object.freeze([
    'MOVE', 'LOADK', 'LOADNIL', 'LOADBOOL', 'NEWTABLE', 'NEWCELL',
    'CELLGET', 'CELLSET', 'GETUP', 'SETUP',
    'GETTAB', 'SETTAB', 'GETTABK', 'SETTABK', 'SELF',
    'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW', 'IDIV',
    'BAND', 'BOR', 'BXOR', 'SHL', 'SHR', 'CAT',
    'UNM', 'NOT', 'LEN', 'BNOT', 'EQ', 'LT', 'LE',
    'JMP', 'JMPIF', 'JMPIFNOT', 'JMPNIL',
    'CALL', 'CALLV', 'RETURN', 'RET0', 'VARARG', 'CLOSURE',
    'FORPREP', 'FORLOOP', 'ITERPREP', 'ITERCALL', 'SETLIST',
    'GETGLOBAL', 'SETGLOBAL'
]);

const BINARY_OP = {
    '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '^': 'POW', '//': 'IDIV',
    '&': 'BAND', '|': 'BOR', '~': 'BXOR', '<<': 'SHL', '>>': 'SHR'
};

const UNARY_OP = {
    '-': 'UNM', 'not': 'NOT', '#': 'LEN', '~': 'BNOT'
};

const MAX_SLOT = 255;
const MAX_OPERAND = 0xffffff;
const MAX_CONSTS = 0xffffff;

export class LuaVmCompileError extends Error {
    constructor(message, line = 0) {
        super(line ? `${message} (line ${line})` : message);
        this.name = 'LuaVmCompileError';
        this.line = line;
    }
}

function isMultiExpression(expr) {
    return expr && (expr.k === 'call' || expr.k === 'method' || expr.k === 'vararg');
}

class Compiler {
    constructor() {
        this.protos = [];
    }

    compileChunk(chunk) {
        for (const statement of chunk.body) {
            if (!statement || typeof statement !== 'object') {
                throw new LuaVmCompileError('internal: invalid statement node');
            }
        }
        const main = new FuncState(this, null, chunk, 'main', true);
        main.compileBlock(chunk.body);
        main.emit('RET0');
        this.finish(main);
        return { protos: this.protos, root: main.id };
    }

    compileFunction(fn, parent) {
        const state = new FuncState(this, parent, fn, parent.name + '/fn', fn.isVararg === true);
        state.compileParams(fn);
        state.compileBlock(fn.body);
        state.emit('RET0');
        this.finish(state);
        return state.id;
    }

    finish(state) {
        if (state.code.length > MAX_OPERAND) {
            throw new LuaVmCompileError('This script is too large for the VM: a single function exceeds the instruction limit. Split the function up.', state.line);
        }
        state.id = this.protos.length;
        this.protos.push({
            id: state.id,
            name: state.name,
            np: state.nparams,
            va: state.isVararg ? 1 : 0,
            ms: state.maxSlots,
            code: state.code,
            consts: state.consts,
            upvals: state.upvals,
            line: state.line
        });
    }
}

class FuncState {
    constructor(compiler, parent, node, name, isVararg) {
        this.compiler = compiler;
        this.parent = parent;
        this.node = node;
        this.name = name;
        this.isVararg = isVararg;
        this.code = [];
        this.consts = [];
        this.constMap = new Map();
        this.upvals = [];
        this.locals = [];
        this.scopeMarks = [];
        this.freereg = 1;
        this.maxSlots = 1;
        this.loops = [];
        this.nparams = 0;
        this.id = -1;
        this.line = node && node.line ? node.line : 0;
        this.boxedNames = (node && node.boxedNames) || new Set();
    }

    error(message, line = this.line) {
        throw new LuaVmCompileError(message, line);
    }

    here() {
        return this.code.length;
    }

    emit(op, a = 0, b = 0, c = 0, line = this.line) {
        const index = this.code.length;
        this.code.push({ op, a, b, c, line });
        return index;
    }

    patchTo(index, target) {
        const instr = this.code[index];
        if (!instr) this.error('internal: bad jump patch');
        if (target > MAX_OPERAND) this.error('This script is too large for the VM: jump target out of range.');
        instr.b = target;
    }

    patchA(index, value) {
        this.code[index].a = value;
    }

    addConst(value) {
        let key;
        if (typeof value === 'number') key = 'n:' + String(value);
        else key = 's:' + value;
        const existing = this.constMap.get(key);
        if (existing !== undefined) return existing;
        if (this.consts.length >= MAX_CONSTS) {
            this.error('This script uses too many constants in one function for the VM.');
        }
        const index = this.consts.length;
        this.consts.push(value);
        this.constMap.set(key, index);
        return index;
    }

    alloc(count = 1) {
        const base = this.freereg;
        const top = base + count - 1;
        if (top > MAX_SLOT) {
            this.error(`This script is too complex for the VM: register limit reached in function '${this.name}'.`);
        }
        this.freereg = base + count;
        if (top > this.maxSlots) this.maxSlots = top;
        return base;
    }

    reserveTo(slot) {
        if (slot < this.freereg) return;
        if (slot > MAX_SLOT) {
            this.error(`This script is too complex for the VM: register limit reached in function '${this.name}'.`);
        }
        this.freereg = slot + 1;
        if (slot > this.maxSlots) this.maxSlots = slot;
    }

    localTop() {
        for (let i = this.locals.length - 1; i >= 0; i--) {
            return this.locals[i].slot + 1;
        }
        return 1;
    }

    enterScope() {
        this.scopeMarks.push(this.locals.length);
    }

    leaveScope() {
        const mark = this.scopeMarks.pop() ?? 0;
        this.locals.length = Math.min(this.locals.length, mark);
        this.freereg = this.localTop();
    }

    findLocal(name) {
        for (let i = this.locals.length - 1; i >= 0; i--) {
            if (this.locals[i].name === name) return this.locals[i];
        }
        return null;
    }

    findUpval(name) {
        for (let i = 0; i < this.upvals.length; i++) {
            if (this.upvals[i].name === name) return i;
        }
        return -1;
    }

    resolveName(name) {
        const local = this.findLocal(name);
        if (local) return { kind: 'local', local };
        const up = this.findUpval(name);
        if (up >= 0) return { kind: 'upval', index: up };
        if (this.parent) {
            const desc = this.parent.provideCell(name);
            if (desc) {
                const index = this.upvals.length;
                this.upvals.push({ name, fromParent: desc.fromParent, index: desc.index });
                return { kind: 'upval', index };
            }
        }
        return { kind: 'global' };
    }

    // Called by a child function that needs a cell for `name`.
    provideCell(name) {
        const local = this.findLocal(name);
        if (local) {
            if (!local.boxed) {
                this.error(`internal: captured local '${name}' was not boxed`, this.line);
            }
            return { fromParent: true, index: local.slot };
        }
        const up = this.findUpval(name);
        if (up >= 0) return { fromParent: false, index: up };
        if (this.parent) {
            const desc = this.parent.provideCell(name);
            if (desc) {
                const index = this.upvals.length;
                this.upvals.push({ name, fromParent: desc.fromParent, index: desc.index });
                return { fromParent: false, index };
            }
        }
        return null;
    }

    declareParam(name) {
        const boxed = this.boxedNames.has(name);
        const slot = this.alloc(1);
        if (boxed) {
            const temp = this.alloc(1);
            this.emit('MOVE', temp, slot);
            this.emit('NEWCELL', slot);
            this.emit('CELLSET', temp, slot);
            this.freereg = slot + 1;
        }
        this.locals.push({ name, slot, boxed });
        this.nparams++;
        return slot;
    }

    compileParams(fn) {
        if (fn.isMethod) this.declareParam('self');
        for (const param of fn.params) this.declareParam(param);
    }

    declareLocal(name) {
        const boxed = this.boxedNames.has(name);
        const slot = this.alloc(1);
        this.locals.push({ name, slot, boxed });
        return { slot, boxed };
    }

    compileBlock(body, scoped = true) {
        if (scoped) this.enterScope();
        for (const statement of body) {
            this.compileStatement(statement);
            this.freereg = this.localTop();
        }
        if (scoped) this.leaveScope();
    }

    compileStatement(statement) {
        switch (statement.k) {
            case 'noop':
            case 'break':
            case 'continue':
                return this.compileLoopFlow(statement);
            case 'local':
                return this.compileLocal(statement);
            case 'localfunction':
                return this.compileLocalFunction(statement);
            case 'funcdecl':
                return this.compileFunctionDeclaration(statement);
            case 'assign':
                return this.compileAssign(statement);
            case 'compound':
                return this.compileCompound(statement);
            case 'callstat': {
                const temp = this.alloc(1);
                this.compileCall(statement.call, 1, temp);
                this.freereg = temp;
                return;
            }
            case 'do':
                this.compileBlock(statement.body);
                return;
            case 'while':
                return this.compileWhile(statement);
            case 'repeat':
                return this.compileRepeat(statement);
            case 'if':
                return this.compileIf(statement);
            case 'fornum':
                return this.compileNumericFor(statement);
            case 'forin':
                return this.compileGenericFor(statement);
            case 'return':
                return this.compileReturn(statement);
            default:
                this.error(`unsupported statement '${statement.k}'`, statement.line);
        }
    }

    compileLoopFlow(statement) {
        if (statement.k === 'noop') return;
        const loop = this.loops[this.loops.length - 1];
        if (!loop) this.error(`'${statement.k}' used outside of a loop`, statement.line);
        const index = this.emit('JMP', 0, 0, 0, statement.line);
        if (statement.k === 'break') loop.breaks.push(index);
        else loop.continues.push(index);
    }

    compileLocal(statement) {
        const names = statement.names;
        const base = this.freereg;
        this.reserveTo(base + names.length - 1);
        this.compileValuesInto(statement.values, base, names.length);
        for (let i = 0; i < names.length; i++) {
            const name = names[i].name;
            const boxed = this.boxedNames.has(name);
            const slot = base + i;
            if (boxed) {
                const temp = this.alloc(1);
                this.emit('MOVE', temp, slot, 0, statement.line);
                this.emit('NEWCELL', slot, 0, 0, statement.line);
                this.emit('CELLSET', temp, slot, 0, statement.line);
                this.freereg = base + names.length;
            }
            this.locals.push({ name, slot, boxed });
        }
        this.freereg = base + names.length;
    }

    compileLocalFunction(statement) {
        const boxed = this.boxedNames.has(statement.name);
        const slot = this.alloc(1);
        if (boxed) this.emit('NEWCELL', slot, 0, 0, statement.line);
        this.locals.push({ name: statement.name, slot, boxed });
        const proto = this.compiler.compileFunction(statement.func, this);
        const temp = this.alloc(1);
        this.emit('CLOSURE', temp, proto, 0, statement.line);
        if (boxed) {
            this.emit('CELLSET', temp, slot, 0, statement.line);
        } else {
            this.emit('MOVE', slot, temp, 0, statement.line);
        }
        this.freereg = slot + 1;
    }

    compileFunctionDeclaration(statement) {
        const target = statement.target;
        if (target.k === 'name') {
            const proto = this.compiler.compileFunction(statement.func, this);
            const temp = this.alloc(1);
            this.emit('CLOSURE', temp, proto, 0, statement.line);
            this.storeName(target.name, temp, statement.line);
            this.freereg = temp;
            return;
        }
        if (target.k !== 'index') this.error('unsupported function declaration target', statement.line);
        const objSlot = this.alloc(1);
        this.exprToSlot(target.obj, objSlot);
        const proto = this.compiler.compileFunction(statement.func, this);
        const temp = this.alloc(1);
        this.emit('CLOSURE', temp, proto, 0, statement.line);
        if (target.key.k === 'string') {
            this.emit('SETTABK', objSlot, this.addConst(target.key.value), temp, statement.line);
        } else {
            const key = this.alloc(1);
            this.exprToSlot(target.key, key);
            this.emit('SETTAB', objSlot, key, temp, statement.line);
        }
        this.freereg = objSlot;
    }

    compileAssign(statement) {
        const indexed = statement.targets.reduce((n, t) => n + (t.k === 'name' ? 0 : 1), 0);
        // Long lists (seen in obfuscator-generated code) cannot fit in the
        // 255-slot window, so they are staged through tables instead.
        if (statement.targets.length + indexed * 2 + 8 > 220) {
            return this.compileBigAssign(statement);
        }
        const mark = this.freereg;
        const targets = [];
        for (const target of statement.targets) {
            if (target.k === 'name') {
                targets.push({ kind: 'name', name: target.name });
                continue;
            }
            if (target.k !== 'index') this.error('invalid assignment target', statement.line);
            // Copy the base and key: Lua resolves them before the right-hand side
            // runs, so a later `t = {}` must not redirect this write.
            const obj = this.alloc(1);
            this.exprToSlot(target.obj, obj);
            let key = -1;
            let keyConst = -1;
            if (target.key.k === 'string') {
                keyConst = this.addConst(target.key.value);
            } else {
                key = this.alloc(1);
                this.exprToSlot(target.key, key);
            }
            targets.push({ kind: 'index', obj, key, keyConst });
        }
        const base = this.alloc(targets.length);
        this.compileValuesInto(statement.values, base, targets.length);
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const value = base + i;
            if (target.kind === 'name') {
                this.storeName(target.name, value, statement.line);
            } else if (target.keyConst >= 0) {
                this.emit('SETTABK', target.obj, target.keyConst, value, statement.line);
            } else {
                this.emit('SETTAB', target.obj, target.key, value, statement.line);
            }
        }
        this.freereg = mark;
    }

    // `a, b, c, ... = x, y, z, ...` with hundreds of targets. Target prefixes
    // are evaluated first, then the values, then the stores, matching Lua's
    // ordering without keeping every operand in a register at once.
    compileBigAssign(statement) {
        const mark = this.freereg;
        const desc = this.alloc(1);
        this.emit('NEWTABLE', desc, 0, 0, statement.line);
        let descIndex = 1;
        for (const target of statement.targets) {
            if (target.k === 'name') continue;
            if (target.k !== 'index') this.error('invalid assignment target', statement.line);
            const obj = this.alloc(1);
            this.exprToSlot(target.obj, obj);
            this.emit('SETTABK', desc, this.addConst(descIndex), obj, statement.line);
            descIndex++;
            const key = this.alloc(1);
            if (target.key.k === 'string') {
                this.emit('LOADK', key, this.addConst(target.key.value), 0, statement.line);
            } else {
                this.exprToSlot(target.key, key);
            }
            this.emit('SETTABK', desc, this.addConst(descIndex), key, statement.line);
            descIndex++;
            this.freereg = mark + 2;
        }

        const vals = this.alloc(1);
        this.emit('NEWTABLE', vals, 0, 0, statement.line);
        const values = statement.values;
        const lastIndex = values.length - 1;
        for (let i = 0; i < values.length; i++) {
            const expr = values[i];
            const temp = this.alloc(1);
            if (i === lastIndex && isMultiExpression(expr)) {
                if (expr.k === 'vararg') this.emit('VARARG', temp, 0, 0, statement.line);
                else this.compileCall(expr, 0, temp);
                this.emit('SETLIST', vals, i + 1, temp, statement.line);
            } else {
                this.exprToSlot(expr, temp);
                this.emit('SETTABK', vals, this.addConst(i + 1), temp, statement.line);
            }
            this.freereg = mark + 3;
        }

        descIndex = 1;
        for (let i = 0; i < statement.targets.length; i++) {
            const target = statement.targets[i];
            const value = this.alloc(1);
            this.emit('GETTABK', value, vals, this.addConst(i + 1), statement.line);
            if (target.k === 'name') {
                this.storeName(target.name, value, statement.line);
            } else {
                const obj = this.alloc(1);
                const key = this.alloc(1);
                this.emit('GETTABK', obj, desc, this.addConst(descIndex), statement.line);
                this.emit('GETTABK', key, desc, this.addConst(descIndex + 1), statement.line);
                this.emit('SETTAB', obj, key, value, statement.line);
                descIndex += 2;
            }
            this.freereg = mark + 3;
        }
        this.freereg = mark;
    }

    compileCompound(statement) {
        const mark = this.freereg;
        const target = statement.target;
        if (target.k === 'name') {
            const current = this.alloc(1);
            this.loadName(target.name, current, statement.line);
            const rhs = this.alloc(1);
            this.exprToSlot(statement.value, rhs);
            const dest = this.alloc(1);
            this.emitBinaryOp(statement.op, dest, current, rhs, statement.line);
            this.storeName(target.name, dest, statement.line);
            this.freereg = mark;
            return;
        }
        const obj = this.alloc(1);
        this.exprToSlot(target.obj, obj);
        let key = -1;
        let keyConst = -1;
        if (target.key.k === 'string') keyConst = this.addConst(target.key.value);
        else {
            key = this.alloc(1);
            this.exprToSlot(target.key, key);
        }
        const current = this.alloc(1);
        if (keyConst >= 0) this.emit('GETTABK', current, obj, keyConst, statement.line);
        else this.emit('GETTAB', current, obj, key, statement.line);
        const rhs = this.alloc(1);
        this.exprToSlot(statement.value, rhs);
        const dest = this.alloc(1);
        this.emitBinaryOp(statement.op, dest, current, rhs, statement.line);
        if (keyConst >= 0) this.emit('SETTABK', obj, keyConst, dest, statement.line);
        else this.emit('SETTAB', obj, key, dest, statement.line);
        this.freereg = mark;
    }

    emitBinaryOp(op, dest, left, right, line) {
        if (op === '..') {
            this.emit('CAT', dest, left, right, line);
            return;
        }
        const mapped = BINARY_OP[op];
        if (mapped) {
            this.emit(mapped, dest, left, right, line);
            return;
        }
        if (op === '==' || op === '~=') {
            this.emit('EQ', dest, left, right, line);
            if (op === '~=') this.emit('NOT', dest, dest, 0, line);
            return;
        }
        if (op === '<') {
            this.emit('LT', dest, left, right, line);
            return;
        }
        if (op === '<=') {
            this.emit('LE', dest, left, right, line);
            return;
        }
        if (op === '>') {
            this.emit('LT', dest, right, left, line);
            return;
        }
        if (op === '>=') {
            this.emit('LE', dest, right, left, line);
            return;
        }
        this.error(`unsupported operator '${op}'`, line);
    }

    compileIf(statement) {
        const ends = [];
        const clauses = statement.clauses;
        for (let i = 0; i < clauses.length; i++) {
            const clause = clauses[i];
            const mark = this.freereg;
            const cond = this.alloc(1);
            this.exprToSlot(clause.cond, cond);
            const jump = this.emit('JMPIFNOT', cond, 0, 0, statement.line);
            this.freereg = mark;
            this.compileBlock(clause.body);
            const hasNext = i < clauses.length - 1 || statement.elseBody;
            if (hasNext) ends.push(this.emit('JMP', 0, 0, 0, statement.line));
            this.patchTo(jump, this.here());
            this.freereg = mark;
        }
        if (statement.elseBody) this.compileBlock(statement.elseBody);
        for (const end of ends) this.patchTo(end, this.here());
    }

    compileWhile(statement) {
        const start = this.here();
        const mark = this.freereg;
        const cond = this.alloc(1);
        this.exprToSlot(statement.cond, cond);
        const exitJump = this.emit('JMPIFNOT', cond, 0, 0, statement.line);
        this.freereg = mark;
        const loop = { breaks: [], continues: [] };
        this.loops.push(loop);
        this.compileBlock(statement.body);
        this.loops.pop();
        this.emit('JMP', 0, start, 0, statement.line);
        const loopExit = this.here();
        this.patchTo(exitJump, loopExit);
        for (const jump of loop.continues) this.patchTo(jump, start);
        for (const jump of loop.breaks) this.patchTo(jump, loopExit);
        this.freereg = mark;
    }

    compileRepeat(statement) {
        const start = this.here();
        const mark = this.freereg;
        this.enterScope();
        const loop = { breaks: [], continues: [] };
        this.loops.push(loop);
        this.compileBlock(statement.body, false);
        const condLabel = this.here();
        for (const jump of loop.continues) this.patchTo(jump, condLabel);
        const cond = this.alloc(1);
        this.exprToSlot(statement.cond, cond);
        this.emit('JMPIFNOT', cond, start, 0, statement.line);
        this.loops.pop();
        this.leaveScope();
        const loopExit = this.here();
        for (const jump of loop.breaks) this.patchTo(jump, loopExit);
        this.freereg = mark;
    }

    compileNumericFor(statement) {
        const mark = this.freereg;
        const ctrl = this.alloc(4);
        this.exprToSlot(statement.init, ctrl);
        this.exprToSlot(statement.limit, ctrl + 1);
        if (statement.step) this.exprToSlot(statement.step, ctrl + 2);
        else this.emit('LOADK', ctrl + 2, this.addConst(1), 0, statement.line);
        const prep = this.emit('FORPREP', ctrl, 0, 0, statement.line);
        const bodyStart = this.here();
        this.enterScope();
        const local = this.declareLocal(statement.name);
        const loop = { breaks: [], continues: [] };
        this.loops.push(loop);
        if (local.boxed) {
            const temp = this.alloc(1);
            this.emit('MOVE', temp, ctrl + 3, 0, statement.line);
            this.emit('NEWCELL', local.slot, 0, 0, statement.line);
            this.emit('CELLSET', temp, local.slot, 0, statement.line);
            this.freereg = local.slot + 1;
        } else {
            this.emit('MOVE', local.slot, ctrl + 3, 0, statement.line);
        }
        this.compileBlock(statement.body, false);
        this.loops.pop();
        this.leaveScope();
        const increment = this.here();
        for (const jump of loop.continues) this.patchTo(jump, increment);
        this.emit('FORLOOP', ctrl, bodyStart, 0, statement.line);
        const loopExit = this.here();
        this.patchTo(prep, loopExit);
        for (const jump of loop.breaks) this.patchTo(jump, loopExit);
        this.freereg = mark;
    }

    compileGenericFor(statement) {
        const mark = this.freereg;
        const names = statement.names;
        const ctrl = this.alloc(3 + names.length);
        this.compileValuesInto(statement.exprs, ctrl, 3);
        this.emit('ITERPREP', ctrl, 0, 0, statement.line);
        const loopStart = this.here();
        this.emit('ITERCALL', ctrl, names.length, 0, statement.line);
        const exitJump = this.emit('JMPNIL', ctrl + 3, 0, 0, statement.line);
        this.emit('MOVE', ctrl + 2, ctrl + 3, 0, statement.line);
        this.enterScope();
        for (let i = 0; i < names.length; i++) {
            const local = this.declareLocal(names[i]);
            if (local.boxed) {
                const temp = this.alloc(1);
                this.emit('MOVE', temp, ctrl + 3 + i, 0, statement.line);
                this.emit('NEWCELL', local.slot, 0, 0, statement.line);
                this.emit('CELLSET', temp, local.slot, 0, statement.line);
                this.freereg = local.slot + 1;
            } else {
                this.emit('MOVE', local.slot, ctrl + 3 + i, 0, statement.line);
            }
        }
        const loop = { breaks: [], continues: [] };
        this.loops.push(loop);
        this.compileBlock(statement.body, false);
        this.loops.pop();
        this.leaveScope();
        this.emit('JMP', 0, loopStart, 0, statement.line);
        const loopExit = this.here();
        this.patchTo(exitJump, loopExit);
        for (const jump of loop.continues) this.patchTo(jump, loopStart);
        for (const jump of loop.breaks) this.patchTo(jump, loopExit);
        this.freereg = mark;
    }

    compileReturn(statement) {
        const values = statement.values;
        if (values.length === 0) {
            this.emit('RET0', 0, 0, 0, statement.line);
            return;
        }
        const last = values[values.length - 1];
        if (isMultiExpression(last)) {
            const base = this.freereg;
            for (let i = 0; i < values.length - 1; i++) {
                const slot = this.alloc(1);
                this.exprToSlot(values[i], slot);
            }
            const callBase = this.alloc(1);
            this.compileValuesInto([last], callBase, 0);
            this.emit('RETURN', base, 0, 0, statement.line);
            this.freereg = base;
            return;
        }
        const base = this.freereg;
        const slots = this.alloc(values.length);
        this.compileValuesInto(values, slots, values.length);
        this.emit('RETURN', slots, values.length, 0, statement.line);
        this.freereg = base;
    }

    // Compiles `list` into consecutive slots starting at `base`, producing
    // exactly `want` values (padded with nil). `want === 0` means "all values".
    compileValuesInto(list, base, want) {
        if (!list || list.length === 0) {
            if (want > 0) this.emit('LOADNIL', base, want);
            return;
        }
        const lastIndex = list.length - 1;
        const take = want > 0 ? Math.min(list.length, want) : list.length;
        for (let i = 0; i < take; i++) {
            const expr = list[i];
            const slot = base + i;
            if (i === lastIndex && isMultiExpression(expr)) {
                if (want === 0) {
                    if (expr.k === 'vararg') this.emit('VARARG', slot, 0);
                    else this.compileCall(expr, 0, slot);
                    return;
                }
                const need = want - i;
                if (expr.k === 'vararg') this.emit('VARARG', slot, need);
                else this.compileCall(expr, need, slot);
                return;
            }
            this.exprToSlot(expr, slot);
        }
        if (want > take) this.emit('LOADNIL', base + take, want - take);
        const restore = base + (want > 0 ? want : take);
        for (let i = take; i < list.length; i++) {
            const temp = this.alloc(1);
            this.exprToSlot(list[i], temp);
            this.freereg = restore;
        }
    }

    exprToSlot(expr, dest) {
        switch (expr.k) {
            case 'nil':
                this.emit('LOADNIL', dest, 1, 0, expr.line);
                return;
            case 'true':
                this.emit('LOADBOOL', dest, 1, 0, expr.line);
                return;
            case 'false':
                this.emit('LOADBOOL', dest, 0, 0, expr.line);
                return;
            case 'number':
                this.emit('LOADK', dest, this.addConst(expr.value), 0, expr.line);
                return;
            case 'string':
                this.emit('LOADK', dest, this.addConst(expr.value), 0, expr.line);
                return;
            case 'vararg':
                this.emit('VARARG', dest, 1, 0, expr.line);
                return;
            case 'paren':
                this.exprToSlot(expr.expr, dest);
                return;
            case 'name':
                this.loadName(expr.name, dest, expr.line);
                return;
            case 'un': {
                const mark = this.freereg;
                const operand = this.valSlot(expr.expr);
                this.emit(UNARY_OP[expr.op] || 'NOT', dest, operand, 0, expr.line);
                this.freereg = mark;
                return;
            }
            case 'bin':
                this.compileBinary(expr, dest);
                return;
            case 'index':
                this.compileIndex(expr, dest);
                return;
            case 'call':
            case 'method':
                this.compileCall(expr, 1, dest);
                return;
            case 'table':
                this.compileTable(expr, dest);
                return;
            case 'function': {
                const proto = this.compiler.compileFunction(expr, this);
                this.emit('CLOSURE', dest, proto, 0, expr.line);
                return;
            }
            case 'ifexpr':
                this.compileIfExpression(expr, dest);
                return;
            case 'interp':
                this.compileInterp(expr, dest);
                return;
            default:
                this.error(`unsupported expression '${expr.k}'`, expr.line);
        }
    }

    compileBinary(expr, dest) {
        if (expr.op === 'and' || expr.op === 'or') {
            const mark = this.freereg;
            this.exprToSlot(expr.left, dest);
            const jump = this.emit(expr.op === 'or' ? 'JMPIF' : 'JMPIFNOT', dest, 0, 0, expr.line);
            this.exprToSlot(expr.right, dest);
            this.patchTo(jump, this.here());
            this.freereg = mark;
            return;
        }
        const mark = this.freereg;
        const left = this.valSlot(expr.left);
        const right = this.valSlot(expr.right);
        this.emitBinaryOp(expr.op, dest, left, right, expr.line);
        this.freereg = mark;
    }

    compileIndex(expr, dest) {
        const mark = this.freereg;
        const obj = this.valSlot(expr.obj);
        if (expr.key.k === 'string') {
            this.emit('GETTABK', dest, obj, this.addConst(expr.key.value), expr.line);
        } else {
            const key = this.valSlot(expr.key);
            this.emit('GETTAB', dest, obj, key, expr.line);
        }
        this.freereg = mark;
    }

    compileIfExpression(expr, dest) {
        const mark = this.freereg;
        const ends = [];
        for (const clause of expr.clauses) {
            const cond = this.alloc(1);
            this.exprToSlot(clause.cond, cond);
            const jump = this.emit('JMPIFNOT', cond, 0, 0, expr.line);
            this.exprToSlot(clause.value, dest);
            ends.push(this.emit('JMP', 0, 0, 0, expr.line));
            this.patchTo(jump, this.here());
            this.freereg = mark;
        }
        this.exprToSlot(expr.elseValue, dest);
        for (const end of ends) this.patchTo(end, this.here());
        this.freereg = mark;
    }

    compileInterp(expr, dest) {
        const mark = this.freereg;
        let first = true;
        for (const part of expr.parts) {
            if (part.kind === 'text') {
                if (part.value === '' && !first) continue;
                const slot = this.alloc(1);
                this.emit('LOADK', slot, this.addConst(part.value), 0, expr.line);
                if (first) {
                    this.emit('MOVE', dest, slot, 0, expr.line);
                    first = false;
                } else {
                    this.emit('CAT', dest, dest, slot, expr.line);
                }
                this.freereg = mark;
                continue;
            }
            const slot = this.alloc(1);
            this.exprToSlot(part.value, slot);
            // Luau interpolation stringifies values with tostring().
            const callBase = this.alloc(2);
            this.emit('GETGLOBAL', callBase, this.addConst('tostring'), 0, expr.line);
            this.emit('MOVE', callBase + 1, slot, 0, expr.line);
            this.emit('CALL', callBase, 1, 1, expr.line);
            if (first) {
                this.emit('MOVE', dest, callBase, 0, expr.line);
                first = false;
            } else {
                this.emit('CAT', dest, dest, callBase, expr.line);
            }
            this.freereg = mark;
        }
        if (first) this.emit('LOADK', dest, this.addConst(''), 0, expr.line);
        this.freereg = mark;
    }

    compileTable(expr, dest) {
        const mark = this.freereg;
        this.emit('NEWTABLE', dest, 0, 0, expr.line);
        let arrayIndex = 1;
        const fields = expr.fields;
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            if (field.kind === 'named') {
                const value = this.valSlot(field.value);
                this.emit('SETTABK', dest, this.addConst(field.name), value, expr.line);
                this.freereg = mark;
                continue;
            }
            if (field.kind === 'keyed') {
                const key = this.valSlot(field.key);
                const value = this.valSlot(field.value);
                this.emit('SETTAB', dest, key, value, expr.line);
                this.freereg = mark;
                continue;
            }
            const isLast = i === fields.length - 1;
            if (isLast && isMultiExpression(field.value)) {
                const values = this.alloc(1);
                if (field.value.k === 'vararg') this.emit('VARARG', values, 0, 0, expr.line);
                else this.compileCall(field.value, 0, values);
                this.emit('SETLIST', dest, arrayIndex, values, expr.line);
                this.freereg = mark;
                return;
            }
            const value = this.valSlot(field.value);
            this.emit('SETTABK', dest, this.addConst(arrayIndex), value, expr.line);
            arrayIndex++;
            this.freereg = mark;
        }
        this.freereg = mark;
    }

    // Returns a slot holding the value. For an unboxed local this is the local's
    // own slot, so read-only callers avoid a copy.
    valSlot(expr) {
        if (expr.k === 'name') {
            const resolved = this.resolveName(expr.name);
            if (resolved.kind === 'local' && !resolved.local.boxed) return resolved.local.slot;
            const slot = this.alloc(1);
            if (resolved.kind === 'local') this.emit('CELLGET', slot, resolved.local.slot, 0, expr.line);
            else if (resolved.kind === 'upval') this.emit('GETUP', slot, resolved.index, 0, expr.line);
            else this.emit('GETGLOBAL', slot, this.addConst(expr.name), 0, expr.line);
            return slot;
        }
        if (expr.k === 'vararg') {
            const slot = this.alloc(1);
            this.emit('VARARG', slot, 1, 0, expr.line);
            return slot;
        }
        if (expr.k === 'call' || expr.k === 'method') {
            const slot = this.alloc(1);
            this.compileCall(expr, 1, slot);
            return slot;
        }
        if (expr.k === 'and' || expr.k === 'or' || expr.k === 'ifexpr' || expr.k === 'table') {
            const slot = this.alloc(1);
            this.exprToSlot(expr, slot);
            return slot;
        }
        if (expr.k === 'number' || expr.k === 'string' || expr.k === 'nil' ||
            expr.k === 'true' || expr.k === 'false' || expr.k === 'paren') {
            if (expr.k === 'paren' && expr.expr.k === 'name') return this.valSlot(expr.expr);
            const slot = this.alloc(1);
            this.exprToSlot(expr, slot);
            return slot;
        }
        const slot = this.alloc(1);
        this.exprToSlot(expr, slot);
        return slot;
    }

    loadName(name, dest, line) {
        const resolved = this.resolveName(name);
        if (resolved.kind === 'local') {
            if (resolved.local.boxed) this.emit('CELLGET', dest, resolved.local.slot, 0, line);
            else if (resolved.local.slot !== dest) this.emit('MOVE', dest, resolved.local.slot, 0, line);
            return;
        }
        if (resolved.kind === 'upval') {
            this.emit('GETUP', dest, resolved.index, 0, line);
            return;
        }
        this.emit('GETGLOBAL', dest, this.addConst(name), 0, line);
    }

    storeName(name, source, line) {
        const resolved = this.resolveName(name);
        if (resolved.kind === 'local') {
            if (resolved.local.boxed) this.emit('CELLSET', source, resolved.local.slot, 0, line);
            else if (resolved.local.slot !== source) this.emit('MOVE', resolved.local.slot, source, 0, line);
            return;
        }
        if (resolved.kind === 'upval') {
            this.emit('SETUP', source, resolved.index, 0, line);
            return;
        }
        this.emit('SETGLOBAL', source, this.addConst(name), 0, line);
    }

    compileCall(expr, nresults, dest) {
        const mark = this.freereg;
        let base;
        let argStart;
        if (nresults === 0 && dest !== this.freereg - 1) {
            this.error('internal: multi-result call must start at the top of the stack', expr.line);
        }
        if (expr.k === 'method') {
            if (nresults === 0) {
                base = dest;
                this.reserveTo(dest + 1);
            } else {
                base = this.alloc(2);
            }
            this.exprToSlot(expr.obj, base + 1);
            this.emit('SELF', base, base + 1, this.addConst(expr.name), expr.line);
            argStart = base + 2;
        } else {
            if (nresults === 0) {
                base = dest;
                this.reserveTo(dest);
            } else {
                base = this.alloc(1);
            }
            this.exprToSlot(expr.fn, base);
            argStart = base + 1;
        }

        let variable = false;
        // Method calls pass `self` at base+1, so it counts as the first
        // argument for CALL/CALLV.
        let fixed = expr.k === 'method' ? 1 : 0;
        const args = expr.args;
        for (let i = 0; i < args.length; i++) {
            const target = argStart + i;
            const isLast = i === args.length - 1;
            this.reserveTo(target);
            if (isLast && isMultiExpression(args[i])) {
                if (args[i].k === 'vararg') {
                    this.emit('VARARG', target, 0, 0, expr.line);
                } else {
                    this.compileCall(args[i], 0, target);
                }
                variable = true;
                break;
            }
            this.exprToSlot(args[i], target);
            fixed++;
        }

        if (variable) {
            this.emit('CALLV', base, nresults, 0, expr.line);
        } else {
            this.emit('CALL', base, fixed, nresults, expr.line);
        }

        if (nresults > 0 && dest !== base) {
            for (let i = 0; i < nresults; i++) {
                if (base + i !== dest + i) this.emit('MOVE', dest + i, base + i, 0, expr.line);
            }
        }
        this.freereg = mark;
    }
}

export function compileLua(source) {
    if (typeof source !== 'string') throw new LuaVmCompileError('The script source must be text.');
    const chunk = parseLua(source);
    const compiler = new Compiler();
    return compiler.compileChunk(chunk);
}

export function compileAst(chunk) {
    const compiler = new Compiler();
    return compiler.compileChunk(chunk);
}
