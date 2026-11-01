import { emit, addConst } from "./bytecode.js";
function createContext(parentCtx) {
    return {
        chunk: { K: [], code: [] },
        locals: new Map(),
        nextSlot: 0,
        loopStack: [],
        parentCtx,
        upvalues: new Map(),
        upvalueList: [],
        hasVarargs: false,
        nParams: 0,
        uniqueCounter: 0,
    };
}
function allocFreshLocal(ctx, baseName) {
    const name = `\0${baseName}_${ctx.uniqueCounter++}`;
    const slot = ctx.nextSlot++;
    ctx.locals.set(name, slot);
    return slot;
}
function addProto(parentCtx, proto) {
    const target = parentCtx.chunk;
    if (!target.protos)
        target.protos = [];
    target.protos.push(proto);
    return target.protos.length;
}
function resolveUpvalue(ctx, name) {
    const existing = ctx.upvalues.get(name);
    if (existing !== undefined)
        return existing;
    if (!ctx.parentCtx)
        return null;
    const parent = ctx.parentCtx;
    const localSlot = parent.locals.get(name);
    if (localSlot !== undefined) {
        const idx = ctx.upvalueList.length;
        ctx.upvalueList.push({ name, isLocal: true, index: localSlot });
        ctx.upvalues.set(name, idx);
        return idx;
    }
    const parentUpval = resolveUpvalue(parent, name);
    if (parentUpval !== null) {
        const idx = ctx.upvalueList.length;
        ctx.upvalueList.push({ name, isLocal: false, index: parentUpval });
        ctx.upvalues.set(name, idx);
        return idx;
    }
    return null;
}
function allocLocal(ctx, name) {
    let slot = ctx.locals.get(name);
    if (slot === undefined) {
        slot = ctx.nextSlot++;
        ctx.locals.set(name, slot);
    }
    return slot;
}
function pushScope(ctx) {
    return new Map(ctx.locals);
}
function popScope(ctx, prev) {
    ctx.locals = prev;
}
function pushLoop(ctx) {
    const loop = { breakPatches: [], continuePatches: [] };
    ctx.loopStack.push(loop);
    return loop;
}
function popLoop(ctx) {
    const loop = ctx.loopStack.pop();
    if (loop) {
        const end = ctx.chunk.code.length;
        for (const idx of loop.breakPatches)
            ctx.chunk.code[idx] = end;
        for (const idx of loop.continuePatches)
            ctx.chunk.code[idx] = end;
    }
}
function resolveContinues(ctx) {
    const loop = ctx.loopStack[ctx.loopStack.length - 1];
    if (loop) {
        const target = ctx.chunk.code.length;
        for (const idx of loop.continuePatches)
            ctx.chunk.code[idx] = target;
        loop.continuePatches = [];
    }
}
function currentLoop(ctx) {
    return ctx.loopStack[ctx.loopStack.length - 1];
}
function isCallLike(exp) {
    return exp.type === "CallExpression" || exp.type === "MethodCallExpression";
}
function hasSpreadArg(args) {
    if (args.length === 0)
        return false;
    const last = args[args.length - 1];
    return isCallLike(last) || last.type === "VarargExpression";
}
function compileSpreadLastArg(ctx, lastArg) {
    if (isCallLike(lastArg)) {
        compileCallMulti(ctx, lastArg, -1);
    }
    else {
        emit(ctx.chunk, 40 /* Op.LOAD_VARARG */, -1);
    }
}
function compileCallMulti(ctx, exp, nResults) {
    const c = ctx.chunk;
    if (exp.type === "MethodCallExpression") {
        const spread = hasSpreadArg(exp.args);
        if (spread) {
            emit(c, 46 /* Op.MARK */);
            compileExpression(ctx, exp.object);
            emit(c, 36 /* Op.DUP */);
            emit(c, 4 /* Op.PUSH_K */, addConst(c, exp.method));
            emit(c, 28 /* Op.GET_TABLE */);
            emit(c, 51 /* Op.SWAP */);
            for (let i = 0; i < exp.args.length - 1; i++)
                compileExpression(ctx, exp.args[i]);
            compileSpreadLastArg(ctx, exp.args[exp.args.length - 1]);
            emit(c, 47 /* Op.CALL_DYNAMIC */, nResults);
        }
        else {
            compileExpression(ctx, exp.object);
            emit(c, 36 /* Op.DUP */);
            emit(c, 4 /* Op.PUSH_K */, addConst(c, exp.method));
            emit(c, 28 /* Op.GET_TABLE */);
            emit(c, 51 /* Op.SWAP */);
            for (const a of exp.args)
                compileExpression(ctx, a);
            emit(c, 39 /* Op.CALL_MULTI */, exp.args.length + 1, nResults);
        }
    }
    else if (exp.type === "CallExpression") {
        const spread = hasSpreadArg(exp.args);
        if (spread) {
            emit(c, 46 /* Op.MARK */);
            compileExpression(ctx, exp.callee);
            for (let i = 0; i < exp.args.length - 1; i++)
                compileExpression(ctx, exp.args[i]);
            compileSpreadLastArg(ctx, exp.args[exp.args.length - 1]);
            emit(c, 47 /* Op.CALL_DYNAMIC */, nResults);
        }
        else {
            compileExpression(ctx, exp.callee);
            for (const a of exp.args)
                compileExpression(ctx, a);
            emit(c, 39 /* Op.CALL_MULTI */, exp.args.length, nResults);
        }
    }
}
function compileFunctionBody(ctx, params, body) {
    const protoCtx = createContext(ctx);
    protoCtx.chunk = { K: [], code: [] };
    let slot = 0;
    let nParams = 0;
    let hasVarargs = false;
    for (const p of params) {
        if (p.variadic) {
            hasVarargs = true;
            continue;
        }
        protoCtx.locals.set(p.name, slot++);
        nParams++;
    }
    protoCtx.nextSlot = slot;
    protoCtx.hasVarargs = hasVarargs;
    protoCtx.nParams = nParams;
    for (const stmt of body)
        compileStatement(protoCtx, stmt);
    const lastStmt = body.length > 0 ? body[body.length - 1] : null;
    if (!lastStmt || lastStmt.type !== "ReturnStatement") {
        emit(protoCtx.chunk, 31 /* Op.RETURN */, 0);
    }
    if (protoCtx.upvalueList.length > 0) {
        protoCtx.chunk.upvalues = protoCtx.upvalueList.map(uv => [
            uv.isLocal ? 1 : 0,
            uv.index
        ]);
    }
    protoCtx.chunk.nParams = nParams;
    protoCtx.chunk.hasVarargs = hasVarargs;
    return addProto(ctx, protoCtx.chunk);
}
function compileExpression(ctx, exp) {
    if (!exp) {
        emit(ctx.chunk, 1 /* Op.PUSH_NIL */);
        return;
    }
    const c = ctx.chunk;
    switch (exp.type) {
        case "NilLiteral":
            emit(c, 1 /* Op.PUSH_NIL */);
            break;
        case "BooleanLiteral":
            emit(c, exp.value ? 2 /* Op.PUSH_TRUE */ : 3 /* Op.PUSH_FALSE */);
            break;
        case "NumberLiteral": {
            const n = Number(exp.value);
            emit(c, 4 /* Op.PUSH_K */, addConst(c, n));
            break;
        }
        case "StringLiteral":
            emit(c, 4 /* Op.PUSH_K */, addConst(c, exp.value));
            break;
        case "Identifier": {
            if (exp.name === "nil") {
                emit(c, 1 /* Op.PUSH_NIL */);
                break;
            }
            if (exp.name === "true") {
                emit(c, 2 /* Op.PUSH_TRUE */);
                break;
            }
            if (exp.name === "false") {
                emit(c, 3 /* Op.PUSH_FALSE */);
                break;
            }
            const slot = ctx.locals.get(exp.name);
            if (slot !== undefined) {
                emit(c, 5 /* Op.LOAD_L */, slot);
            }
            else {
                const upvalIdx = resolveUpvalue(ctx, exp.name);
                if (upvalIdx !== null) {
                    emit(c, 37 /* Op.LOAD_UPVAL */, upvalIdx);
                }
                else {
                    emit(c, 7 /* Op.LOAD_G */, addConst(c, exp.name));
                }
            }
            break;
        }
        case "BinaryExpression": {
            if (exp.operator === "and") {
                compileExpression(ctx, exp.left);
                emit(c, 36 /* Op.DUP */);
                const jmpFalse = c.code.length;
                emit(c, 33 /* Op.JMP_F */, 0);
                emit(c, 34 /* Op.POP */, 1);
                compileExpression(ctx, exp.right);
                c.code[jmpFalse + 1] = c.code.length;
                break;
            }
            if (exp.operator === "or") {
                compileExpression(ctx, exp.left);
                emit(c, 36 /* Op.DUP */);
                emit(c, 24 /* Op.NOT */);
                const jmpTrue = c.code.length;
                emit(c, 33 /* Op.JMP_F */, 0);
                emit(c, 34 /* Op.POP */, 1);
                compileExpression(ctx, exp.right);
                c.code[jmpTrue + 1] = c.code.length;
                break;
            }
            compileExpression(ctx, exp.left);
            compileExpression(ctx, exp.right);
            const opMap = {
                "+": 9 /* Op.ADD */, "-": 10 /* Op.SUB */, "*": 11 /* Op.MUL */, "/": 12 /* Op.DIV */,
                "%": 13 /* Op.MOD */, "^": 14 /* Op.POW */, "..": 15 /* Op.CONCAT */,
                "//": 48 /* Op.IDIV */,
                "==": 16 /* Op.EQ */, "~=": 17 /* Op.NE */, "<": 18 /* Op.LT */, "<=": 19 /* Op.LE */,
                ">": 20 /* Op.GT */, ">=": 21 /* Op.GE */,
            };
            const op = opMap[exp.operator];
            if (op !== undefined)
                emit(c, op);
            break;
        }
        case "UnaryExpression": {
            compileExpression(ctx, exp.argument);
            if (exp.operator === "not")
                emit(c, 24 /* Op.NOT */);
            else if (exp.operator === "-")
                emit(c, 25 /* Op.UNM */);
            else if (exp.operator === "#")
                emit(c, 26 /* Op.LEN */);
            break;
        }
        case "ParenExpression":
            compileExpression(ctx, exp.expression);
            break;
        case "CallExpression": {
            if (hasSpreadArg(exp.args)) {
                emit(c, 46 /* Op.MARK */);
                compileExpression(ctx, exp.callee);
                for (let i = 0; i < exp.args.length - 1; i++)
                    compileExpression(ctx, exp.args[i]);
                compileSpreadLastArg(ctx, exp.args[exp.args.length - 1]);
                emit(c, 47 /* Op.CALL_DYNAMIC */, 1);
            }
            else {
                compileExpression(ctx, exp.callee);
                for (const a of exp.args)
                    compileExpression(ctx, a);
                emit(c, 30 /* Op.CALL */, exp.args.length);
            }
            break;
        }
        case "MethodCallExpression": {
            if (hasSpreadArg(exp.args)) {
                emit(c, 46 /* Op.MARK */);
                compileExpression(ctx, exp.object);
                emit(c, 36 /* Op.DUP */);
                emit(c, 4 /* Op.PUSH_K */, addConst(c, exp.method));
                emit(c, 28 /* Op.GET_TABLE */);
                emit(c, 51 /* Op.SWAP */);
                for (let i = 0; i < exp.args.length - 1; i++)
                    compileExpression(ctx, exp.args[i]);
                compileSpreadLastArg(ctx, exp.args[exp.args.length - 1]);
                emit(c, 47 /* Op.CALL_DYNAMIC */, 1);
            }
            else {
                compileExpression(ctx, exp.object);
                emit(c, 36 /* Op.DUP */);
                const idx = addConst(c, exp.method);
                emit(c, 4 /* Op.PUSH_K */, idx);
                emit(c, 28 /* Op.GET_TABLE */);
                emit(c, 51 /* Op.SWAP */);
                for (const a of exp.args)
                    compileExpression(ctx, a);
                emit(c, 30 /* Op.CALL */, exp.args.length + 1);
            }
            break;
        }
        case "IndexExpression":
            compileExpression(ctx, exp.object);
            compileExpression(ctx, exp.index);
            emit(c, 28 /* Op.GET_TABLE */);
            break;
        case "MemberExpression":
            compileExpression(ctx, exp.object);
            emit(c, 4 /* Op.PUSH_K */, addConst(c, exp.property));
            emit(c, 28 /* Op.GET_TABLE */);
            break;
        case "TableConstructor": {
            emit(c, 27 /* Op.NEW_TABLE */);
            let arrIdx = 0;
            const fields = exp.fields;
            for (let fi = 0; fi < fields.length; fi++) {
                const f = fields[fi];
                const isLast = fi === fields.length - 1;
                if (f.kind === "index") {
                    emit(c, 36 /* Op.DUP */);
                    compileExpression(ctx, f.index);
                    compileExpression(ctx, f.value);
                    emit(c, 29 /* Op.SET_TABLE */);
                }
                else if (f.kind === "named") {
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 4 /* Op.PUSH_K */, addConst(c, f.name));
                    compileExpression(ctx, f.value);
                    emit(c, 29 /* Op.SET_TABLE */);
                }
                else {
                    arrIdx++;
                    if (isLast && (isCallLike(f.value) || f.value.type === "VarargExpression")) {
                        emit(c, 46 /* Op.MARK */);
                        if (isCallLike(f.value)) {
                            compileCallMulti(ctx, f.value, -1);
                        }
                        else {
                            emit(c, 40 /* Op.LOAD_VARARG */, -1);
                        }
                        emit(c, 50 /* Op.SETLIST */, arrIdx);
                    }
                    else {
                        emit(c, 36 /* Op.DUP */);
                        emit(c, 4 /* Op.PUSH_K */, addConst(c, arrIdx));
                        compileExpression(ctx, f.value);
                        emit(c, 29 /* Op.SET_TABLE */);
                    }
                }
            }
            break;
        }
        case "TypeAssertion":
            compileExpression(ctx, exp.expression);
            break;
        case "VarargExpression":
            emit(c, 40 /* Op.LOAD_VARARG */, 1);
            break;
        case "StringInterpolation": {
            if (exp.parts.length === 0) {
                emit(c, 4 /* Op.PUSH_K */, addConst(c, ""));
            }
            else {
                let first = true;
                for (const p of exp.parts) {
                    if (typeof p === "string") {
                        emit(c, 4 /* Op.PUSH_K */, addConst(c, p));
                    }
                    else {
                        compileExpression(ctx, p);
                    }
                    if (!first)
                        emit(c, 15 /* Op.CONCAT */);
                    first = false;
                }
            }
            break;
        }
        case "FunctionExpression": {
            const proto = compileFunctionBody(ctx, exp.params, exp.body);
            emit(c, 35 /* Op.CLOSURE */, proto);
            break;
        }
        case "IfElseExpression": {
            const endJumps = [];
            compileExpression(ctx, exp.condition);
            const jmpElse = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            compileExpression(ctx, exp.thenExp);
            endJumps.push(c.code.length + 1);
            emit(c, 32 /* Op.JMP */, 0);
            c.code[jmpElse + 1] = c.code.length;
            if (exp.elseifClauses) {
                for (const clause of exp.elseifClauses) {
                    compileExpression(ctx, clause.condition);
                    const jmpNext = c.code.length;
                    emit(c, 33 /* Op.JMP_F */, 0);
                    compileExpression(ctx, clause.value);
                    endJumps.push(c.code.length + 1);
                    emit(c, 32 /* Op.JMP */, 0);
                    c.code[jmpNext + 1] = c.code.length;
                }
            }
            compileExpression(ctx, exp.elseExp);
            const end = c.code.length;
            for (const pos of endJumps)
                c.code[pos] = end;
            break;
        }
        default:
            emit(c, 1 /* Op.PUSH_NIL */);
    }
}
function compileStatement(ctx, stmt) {
    if (!stmt)
        return;
    const c = ctx.chunk;
    switch (stmt.type) {
        case "LocalStatement": {
            const nVars = stmt.vars.length;
            if (stmt.values && stmt.values.length > 0) {
                const nVals = stmt.values.length;
                const lastVal = stmt.values[nVals - 1];
                const extraNeeded = nVars - nVals;
                if (nVals === 1 && extraNeeded > 0 && isCallLike(lastVal)) {
                    compileCallMulti(ctx, lastVal, nVars);
                }
                else if (nVals > 1 && extraNeeded > 0 && isCallLike(lastVal)) {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    compileCallMulti(ctx, lastVal, extraNeeded + 1);
                }
                else if (nVals === 1 && extraNeeded > 0 && lastVal.type === "VarargExpression") {
                    emit(c, 40 /* Op.LOAD_VARARG */, nVars);
                }
                else if (nVals > 1 && extraNeeded > 0 && lastVal.type === "VarargExpression") {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    emit(c, 40 /* Op.LOAD_VARARG */, extraNeeded + 1);
                }
                else {
                    for (const val of stmt.values)
                        compileExpression(ctx, val);
                    if (nVals > nVars) {
                        emit(c, 34 /* Op.POP */, nVals - nVars);
                    }
                    for (let i = 0; i < nVars - nVals; i++) {
                        emit(c, 1 /* Op.PUSH_NIL */);
                    }
                }
                for (const v of stmt.vars)
                    allocLocal(ctx, v.name);
                for (let i = nVars - 1; i >= 0; i--) {
                    emit(c, 6 /* Op.STORE_L */, ctx.locals.get(stmt.vars[i].name));
                }
            }
            else {
                for (const v of stmt.vars) {
                    allocLocal(ctx, v.name);
                    emit(c, 1 /* Op.PUSH_NIL */);
                    emit(c, 6 /* Op.STORE_L */, ctx.locals.get(v.name));
                }
            }
            break;
        }
        case "AssignmentStatement": {
            const nVars = stmt.vars.length;
            const nVals = stmt.values.length;
            const allSimple = stmt.vars.every(v => v.type === "Identifier");
            if (allSimple && nVals > 0 && nVars >= nVals) {
                const lastVal = stmt.values[nVals - 1];
                const extraNeeded = nVars - nVals;
                if (nVals === 1 && isCallLike(lastVal)) {
                    compileCallMulti(ctx, lastVal, nVars);
                }
                else if (nVals > 1 && isCallLike(lastVal)) {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    compileCallMulti(ctx, lastVal, extraNeeded + 1);
                }
                else if (nVals === 1 && lastVal.type === "VarargExpression") {
                    emit(c, 40 /* Op.LOAD_VARARG */, nVars);
                }
                else if (nVals > 1 && lastVal.type === "VarargExpression") {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    emit(c, 40 /* Op.LOAD_VARARG */, extraNeeded + 1);
                }
                else {
                    for (const val of stmt.values)
                        compileExpression(ctx, val);
                    for (let i = 0; i < extraNeeded; i++)
                        emit(c, 1 /* Op.PUSH_NIL */);
                }
                for (let i = nVars - 1; i >= 0; i--) {
                    const v = stmt.vars[i];
                    const slot = ctx.locals.get(v.name);
                    if (slot !== undefined) {
                        emit(c, 6 /* Op.STORE_L */, slot);
                    }
                    else {
                        const upvalIdx = resolveUpvalue(ctx, v.name);
                        if (upvalIdx !== null) {
                            emit(c, 38 /* Op.STORE_UPVAL */, upvalIdx);
                        }
                        else {
                            emit(c, 8 /* Op.STORE_G */, addConst(c, v.name));
                        }
                    }
                }
            }
            else {
                const n = Math.min(nVars, nVals);
                for (let i = 0; i < n; i++) {
                    const v = stmt.vars[i];
                    const val = stmt.values[i];
                    if (v.type === "Identifier") {
                        compileExpression(ctx, val);
                        const slot = ctx.locals.get(v.name);
                        if (slot !== undefined) {
                            emit(c, 6 /* Op.STORE_L */, slot);
                        }
                        else {
                            const upvalIdx = resolveUpvalue(ctx, v.name);
                            if (upvalIdx !== null) {
                                emit(c, 38 /* Op.STORE_UPVAL */, upvalIdx);
                            }
                            else {
                                emit(c, 8 /* Op.STORE_G */, addConst(c, v.name));
                            }
                        }
                    }
                    else {
                        if (v.type === "IndexExpression") {
                            compileExpression(ctx, v.object);
                            compileExpression(ctx, v.index);
                        }
                        else if (v.type === "MemberExpression") {
                            compileExpression(ctx, v.object);
                            emit(c, 4 /* Op.PUSH_K */, addConst(c, v.property));
                        }
                        compileExpression(ctx, val);
                        emit(c, 29 /* Op.SET_TABLE */);
                    }
                }
                for (let i = n; i < nVars; i++) {
                    const v = stmt.vars[i];
                    if (v.type === "Identifier") {
                        emit(c, 1 /* Op.PUSH_NIL */);
                        const slot = ctx.locals.get(v.name);
                        if (slot !== undefined) {
                            emit(c, 6 /* Op.STORE_L */, slot);
                        }
                        else {
                            const upvalIdx = resolveUpvalue(ctx, v.name);
                            if (upvalIdx !== null) {
                                emit(c, 38 /* Op.STORE_UPVAL */, upvalIdx);
                            }
                            else {
                                emit(c, 8 /* Op.STORE_G */, addConst(c, v.name));
                            }
                        }
                    }
                }
                for (let i = n; i < nVals; i++) {
                    compileExpression(ctx, stmt.values[i]);
                    emit(c, 34 /* Op.POP */, 1);
                }
            }
            break;
        }
        case "CompoundAssignmentStatement": {
            const opMap = {
                "+": 9 /* Op.ADD */, "-": 10 /* Op.SUB */, "*": 11 /* Op.MUL */, "/": 12 /* Op.DIV */,
                "%": 13 /* Op.MOD */, "..": 15 /* Op.CONCAT */, "^": 14 /* Op.POW */,
                "//": 48 /* Op.IDIV */,
            };
            const baseOp = stmt.operator.replace("=", "");
            const binOp = opMap[baseOp];
            if (stmt.var.type === "Identifier") {
                compileExpression(ctx, stmt.var);
                compileExpression(ctx, stmt.value);
                if (binOp)
                    emit(c, binOp);
                const slot = ctx.locals.get(stmt.var.name);
                if (slot !== undefined) {
                    emit(c, 6 /* Op.STORE_L */, slot);
                }
                else {
                    const upvalIdx = resolveUpvalue(ctx, stmt.var.name);
                    if (upvalIdx !== null) {
                        emit(c, 38 /* Op.STORE_UPVAL */, upvalIdx);
                    }
                    else {
                        emit(c, 8 /* Op.STORE_G */, addConst(c, stmt.var.name));
                    }
                }
            }
            else {
                const tempTable = allocFreshLocal(ctx, "cmpd_tbl");
                const tempKey = allocFreshLocal(ctx, "cmpd_key");
                if (stmt.var.type === "IndexExpression") {
                    compileExpression(ctx, stmt.var.object);
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 6 /* Op.STORE_L */, tempTable);
                    compileExpression(ctx, stmt.var.index);
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 6 /* Op.STORE_L */, tempKey);
                }
                else {
                    compileExpression(ctx, stmt.var.object);
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 6 /* Op.STORE_L */, tempTable);
                    emit(c, 4 /* Op.PUSH_K */, addConst(c, stmt.var.property));
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 6 /* Op.STORE_L */, tempKey);
                }
                emit(c, 28 /* Op.GET_TABLE */);
                compileExpression(ctx, stmt.value);
                if (binOp)
                    emit(c, binOp);
                const tempVal = allocFreshLocal(ctx, "cmpd_val");
                emit(c, 6 /* Op.STORE_L */, tempVal);
                emit(c, 5 /* Op.LOAD_L */, tempTable);
                emit(c, 5 /* Op.LOAD_L */, tempKey);
                emit(c, 5 /* Op.LOAD_L */, tempVal);
                emit(c, 29 /* Op.SET_TABLE */);
            }
            break;
        }
        case "FunctionCallStatement": {
            const call = stmt.call;
            const callArgs = call.args || [];
            const isMethod = call.type === "MethodCallExpression" || (call.object && call.method);
            const spread = hasSpreadArg(callArgs);
            if (isMethod) {
                if (spread) {
                    emit(c, 46 /* Op.MARK */);
                    compileExpression(ctx, call.object);
                    emit(c, 36 /* Op.DUP */);
                    emit(c, 4 /* Op.PUSH_K */, addConst(c, call.method));
                    emit(c, 28 /* Op.GET_TABLE */);
                    emit(c, 51 /* Op.SWAP */);
                    for (let i = 0; i < callArgs.length - 1; i++)
                        compileExpression(ctx, callArgs[i]);
                    compileSpreadLastArg(ctx, callArgs[callArgs.length - 1]);
                    emit(c, 47 /* Op.CALL_DYNAMIC */, 1);
                }
                else {
                    compileExpression(ctx, call.object);
                    emit(c, 36 /* Op.DUP */);
                    const idx = addConst(c, call.method);
                    emit(c, 4 /* Op.PUSH_K */, idx);
                    emit(c, 28 /* Op.GET_TABLE */);
                    emit(c, 51 /* Op.SWAP */);
                    for (const a of callArgs)
                        compileExpression(ctx, a);
                    emit(c, 30 /* Op.CALL */, callArgs.length + 1);
                }
            }
            else {
                if (spread) {
                    emit(c, 46 /* Op.MARK */);
                    compileExpression(ctx, call.callee || call);
                    for (let i = 0; i < callArgs.length - 1; i++)
                        compileExpression(ctx, callArgs[i]);
                    compileSpreadLastArg(ctx, callArgs[callArgs.length - 1]);
                    emit(c, 47 /* Op.CALL_DYNAMIC */, 1);
                }
                else {
                    compileExpression(ctx, call.callee || call);
                    for (const a of callArgs)
                        compileExpression(ctx, a);
                    emit(c, 30 /* Op.CALL */, callArgs.length);
                }
            }
            emit(c, 34 /* Op.POP */, 1);
            break;
        }
        case "DoStatement": {
            const prev = pushScope(ctx);
            for (const s of stmt.body)
                compileStatement(ctx, s);
            popScope(ctx, prev);
            break;
        }
        case "WhileStatement": {
            const condStart = c.code.length;
            pushLoop(ctx);
            compileExpression(ctx, stmt.condition);
            const jmpOut = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            const prev = pushScope(ctx);
            const bodySlotStart = ctx.nextSlot;
            for (const s of stmt.body)
                compileStatement(ctx, s);
            const bodySlotEnd = ctx.nextSlot;
            popScope(ctx, prev);
            resolveContinues(ctx);
            for (let s = bodySlotStart; s < bodySlotEnd; s++)
                emit(c, 49 /* Op.CLOSE_UPVAL */, s);
            emit(c, 32 /* Op.JMP */, condStart);
            c.code[jmpOut + 1] = c.code.length;
            popLoop(ctx);
            break;
        }
        case "RepeatStatement": {
            const bodyStart = c.code.length;
            pushLoop(ctx);
            const prev = pushScope(ctx);
            const bodySlotStart = ctx.nextSlot;
            for (const s of stmt.body)
                compileStatement(ctx, s);
            const bodySlotEnd = ctx.nextSlot;
            popScope(ctx, prev);
            resolveContinues(ctx);
            for (let s = bodySlotStart; s < bodySlotEnd; s++)
                emit(c, 49 /* Op.CLOSE_UPVAL */, s);
            compileExpression(ctx, stmt.condition);
            const jmpBack = c.code.length;
            emit(c, 33 /* Op.JMP_F */, bodyStart);
            popLoop(ctx);
            break;
        }
        case "IfStatement": {
            const endJumps = [];
            compileExpression(ctx, stmt.condition);
            const jmpElse = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            const prev = pushScope(ctx);
            for (const s of stmt.thenBody)
                compileStatement(ctx, s);
            popScope(ctx, prev);
            endJumps.push(c.code.length + 1);
            emit(c, 32 /* Op.JMP */, 0);
            c.code[jmpElse + 1] = c.code.length;
            for (const ec of stmt.elseifClauses) {
                compileExpression(ctx, ec.condition);
                const jmpNext = c.code.length;
                emit(c, 33 /* Op.JMP_F */, 0);
                const p2 = pushScope(ctx);
                for (const s of ec.body)
                    compileStatement(ctx, s);
                popScope(ctx, p2);
                endJumps.push(c.code.length + 1);
                emit(c, 32 /* Op.JMP */, 0);
                c.code[jmpNext + 1] = c.code.length;
            }
            if (stmt.elseBody) {
                const p2 = pushScope(ctx);
                for (const s of stmt.elseBody)
                    compileStatement(ctx, s);
                popScope(ctx, p2);
            }
            const end = c.code.length;
            for (const pos of endJumps)
                c.code[pos] = end;
            break;
        }
        case "ForNumericStatement": {
            const prev = pushScope(ctx);
            const hiddenCounter = allocFreshLocal(ctx, "forcount");
            const limitSlot = allocFreshLocal(ctx, "limit");
            const stepSlot = allocFreshLocal(ctx, "step");
            const counterSlot = allocLocal(ctx, stmt.var.name);
            compileExpression(ctx, stmt.start);
            emit(c, 6 /* Op.STORE_L */, hiddenCounter);
            compileExpression(ctx, stmt.end);
            emit(c, 6 /* Op.STORE_L */, limitSlot);
            compileExpression(ctx, stmt.step ?? { type: "NumberLiteral", value: "1", loc: stmt.loc });
            emit(c, 6 /* Op.STORE_L */, stepSlot);
            const condStart = c.code.length;
            emit(c, 5 /* Op.LOAD_L */, stepSlot);
            emit(c, 4 /* Op.PUSH_K */, addConst(c, 0));
            emit(c, 20 /* Op.GT */);
            const jmpNegCheck = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            emit(c, 5 /* Op.LOAD_L */, hiddenCounter);
            emit(c, 5 /* Op.LOAD_L */, limitSlot);
            emit(c, 19 /* Op.LE */);
            const jmpEndPos = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            const jmpToBody = c.code.length;
            emit(c, 32 /* Op.JMP */, 0);
            c.code[jmpNegCheck + 1] = c.code.length;
            emit(c, 5 /* Op.LOAD_L */, hiddenCounter);
            emit(c, 5 /* Op.LOAD_L */, limitSlot);
            emit(c, 21 /* Op.GE */);
            const jmpEndNeg = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            c.code[jmpToBody + 1] = c.code.length;
            pushLoop(ctx);
            emit(c, 49 /* Op.CLOSE_UPVAL */, counterSlot);
            emit(c, 5 /* Op.LOAD_L */, hiddenCounter);
            emit(c, 6 /* Op.STORE_L */, counterSlot);
            const bodySlotStartNum = ctx.nextSlot;
            for (const s of stmt.body)
                compileStatement(ctx, s);
            const bodySlotEndNum = ctx.nextSlot;
            resolveContinues(ctx);
            for (let s = bodySlotStartNum; s < bodySlotEndNum; s++)
                emit(c, 49 /* Op.CLOSE_UPVAL */, s);
            emit(c, 5 /* Op.LOAD_L */, hiddenCounter);
            emit(c, 5 /* Op.LOAD_L */, stepSlot);
            emit(c, 9 /* Op.ADD */);
            emit(c, 6 /* Op.STORE_L */, hiddenCounter);
            emit(c, 32 /* Op.JMP */, condStart);
            const loopEnd = c.code.length;
            c.code[jmpEndPos + 1] = loopEnd;
            c.code[jmpEndNeg + 1] = loopEnd;
            popLoop(ctx);
            popScope(ctx, prev);
            break;
        }
        case "ForInStatement": {
            const iterCount = stmt.iter.length;
            const needed = 3;
            if (iterCount === 1 && isCallLike(stmt.iter[0])) {
                compileCallMulti(ctx, stmt.iter[0], needed);
            }
            else if (iterCount > 1 && isCallLike(stmt.iter[iterCount - 1])) {
                for (let i = 0; i < iterCount - 1; i++)
                    compileExpression(ctx, stmt.iter[i]);
                const remaining = needed - (iterCount - 1);
                compileCallMulti(ctx, stmt.iter[iterCount - 1], remaining);
            }
            else {
                for (const e of stmt.iter)
                    compileExpression(ctx, e);
                if (iterCount < needed) {
                    for (let i = 0; i < needed - iterCount; i++)
                        emit(c, 1 /* Op.PUSH_NIL */);
                }
            }
            const prev = pushScope(ctx);
            const __iter = allocFreshLocal(ctx, "iter");
            const __state = allocFreshLocal(ctx, "state");
            const __var = allocFreshLocal(ctx, "var");
            emit(c, 6 /* Op.STORE_L */, __var);
            emit(c, 6 /* Op.STORE_L */, __state);
            emit(c, 6 /* Op.STORE_L */, __iter);
            emit(c, 56 /* Op.ITER_PREP */, __iter, __state, __var);
            const varSlots = stmt.vars.map(v => allocLocal(ctx, v.name));
            const nVars = varSlots.length;
            const loopStart = c.code.length;
            pushLoop(ctx);
            for (const slot of varSlots) {
                emit(c, 49 /* Op.CLOSE_UPVAL */, slot);
            }
            emit(c, 5 /* Op.LOAD_L */, __iter);
            emit(c, 5 /* Op.LOAD_L */, __state);
            emit(c, 5 /* Op.LOAD_L */, __var);
            emit(c, 39 /* Op.CALL_MULTI */, 2, nVars);
            for (let i = nVars - 1; i >= 0; i--) {
                emit(c, 6 /* Op.STORE_L */, varSlots[i]);
            }
            emit(c, 5 /* Op.LOAD_L */, varSlots[0]);
            emit(c, 6 /* Op.STORE_L */, __var);
            emit(c, 5 /* Op.LOAD_L */, varSlots[0]);
            emit(c, 1 /* Op.PUSH_NIL */);
            emit(c, 17 /* Op.NE */);
            const jmpOut = c.code.length;
            emit(c, 33 /* Op.JMP_F */, 0);
            const bodySlotStartIn = ctx.nextSlot;
            for (const s of stmt.body)
                compileStatement(ctx, s);
            const bodySlotEndIn = ctx.nextSlot;
            resolveContinues(ctx);
            for (let s = bodySlotStartIn; s < bodySlotEndIn; s++)
                emit(c, 49 /* Op.CLOSE_UPVAL */, s);
            emit(c, 32 /* Op.JMP */, loopStart);
            c.code[jmpOut + 1] = c.code.length;
            popLoop(ctx);
            popScope(ctx, prev);
            break;
        }
        case "ReturnStatement": {
            if (stmt.values && stmt.values.length > 0) {
                const nVals = stmt.values.length;
                const lastVal = stmt.values[nVals - 1];
                if (nVals === 1 && isCallLike(lastVal)) {
                    compileCallMulti(ctx, lastVal, -1);
                    emit(c, 31 /* Op.RETURN */, -1);
                }
                else if (nVals === 1 && lastVal.type === "VarargExpression") {
                    emit(c, 40 /* Op.LOAD_VARARG */, -1);
                    emit(c, 31 /* Op.RETURN */, -1);
                }
                else if (nVals > 1 && isCallLike(lastVal)) {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    compileCallMulti(ctx, lastVal, -1);
                    emit(c, 31 /* Op.RETURN */, -1);
                }
                else if (nVals > 1 && lastVal.type === "VarargExpression") {
                    for (let i = 0; i < nVals - 1; i++)
                        compileExpression(ctx, stmt.values[i]);
                    emit(c, 40 /* Op.LOAD_VARARG */, -1);
                    emit(c, 31 /* Op.RETURN */, -1);
                }
                else {
                    for (const v of stmt.values)
                        compileExpression(ctx, v);
                    emit(c, 31 /* Op.RETURN */, nVals);
                }
            }
            else {
                emit(c, 31 /* Op.RETURN */, 0);
            }
            break;
        }
        case "BreakStatement": {
            const loop = currentLoop(ctx);
            if (loop) {
                loop.breakPatches.push(c.code.length + 1);
                emit(c, 32 /* Op.JMP */, 0);
            }
            break;
        }
        case "ContinueStatement": {
            const loop = currentLoop(ctx);
            if (loop) {
                loop.continuePatches.push(c.code.length + 1);
                emit(c, 32 /* Op.JMP */, 0);
            }
            break;
        }
        case "LocalFunctionStatement": {
            allocLocal(ctx, stmt.name);
            const proto = compileFunctionBody(ctx, stmt.params, stmt.body);
            emit(c, 35 /* Op.CLOSURE */, proto);
            emit(c, 6 /* Op.STORE_L */, ctx.locals.get(stmt.name));
            break;
        }
        case "FunctionStatement": {
            const fn = stmt.name;
            const params = fn.method
                ? [{ name: "self", variadic: false }, ...stmt.params]
                : stmt.params;
            const proto = compileFunctionBody(ctx, params, stmt.body);
            if (fn.method) {
                compileExpression(ctx, fn.base);
                emit(c, 4 /* Op.PUSH_K */, addConst(c, fn.method));
                emit(c, 35 /* Op.CLOSURE */, proto);
                emit(c, 29 /* Op.SET_TABLE */);
            }
            else if (fn.base.type === "Identifier") {
                const slot = ctx.locals.get(fn.base.name);
                emit(c, 35 /* Op.CLOSURE */, proto);
                if (slot !== undefined) {
                    emit(c, 6 /* Op.STORE_L */, slot);
                }
                else {
                    emit(c, 8 /* Op.STORE_G */, addConst(c, fn.base.name));
                }
            }
            else if (fn.base.type === "MemberExpression") {
                compileExpression(ctx, fn.base.object);
                emit(c, 4 /* Op.PUSH_K */, addConst(c, fn.base.property));
                emit(c, 35 /* Op.CLOSURE */, proto);
                emit(c, 29 /* Op.SET_TABLE */);
            }
            break;
        }
        case "TypeStatement":
        case "ExportTypeStatement":
        case "TypeFunctionStatement":
        case "ExportTypeFunctionStatement":
            break;
        default:
            break;
    }
}
export function compile(ast) {
    const ctx = createContext();
    for (const stmt of ast.body)
        compileStatement(ctx, stmt);
    const lastStmt = ast.body.length > 0 ? ast.body[ast.body.length - 1] : null;
    if (!lastStmt || lastStmt.type !== "ReturnStatement") {
        emit(ctx.chunk, 31 /* Op.RETURN */, 0);
    }
    return ctx.chunk;
}
//# sourceMappingURL=Compiler.js.map