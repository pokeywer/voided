function isTruthy(v) {
    return v !== null && v !== undefined && v !== false;
}
function luaLen(v) {
    if (typeof v === "string")
        return v.length;
    if (v && typeof v === "object") {
        const t = v;
        let len = 0;
        while (t[len + 1] !== undefined && t[len + 1] !== null)
            len++;
        return len;
    }
    return 0;
}
function luaToString(v) {
    if (v === null || v === undefined)
        return "nil";
    if (typeof v === "boolean")
        return v ? "true" : "false";
    if (typeof v === "number")
        return String(v);
    if (typeof v === "string")
        return v;
    if (typeof v === "function")
        return "function";
    if (typeof v === "object")
        return "table";
    return String(v);
}
export function runVM(K, code, env, key = 0, protos = [], initLocals = {}, upvalues = {}, varargs = [], options = {}) {
    const onTick = options.onTick;
    const tickInterval = options.tickInterval ?? 1000;
    let tickCounter = 0;
    const stack = [];
    const locals = { ...initLocals };
    const localBoxes = {};
    const callBasesStack = [];
    let callBaseStackTop = 0;
    let ip = 0;
    let stackTop = 0;
    function push(v) { stack[stackTop++] = v; }
    function pop() { const v = stack[--stackTop]; stack[stackTop] = undefined; return v; }
    function top() { return stack[stackTop - 1]; }
    function getLocal(slot) {
        const box = localBoxes[slot];
        if (box)
            return box[0];
        return locals[slot];
    }
    function setLocal(slot, val) {
        const box = localBoxes[slot];
        if (box) {
            box[0] = val;
        }
        else {
            locals[slot] = val;
        }
    }
    function boxLocal(slot) {
        if (!localBoxes[slot]) {
            localBoxes[slot] = [locals[slot]];
        }
        return localBoxes[slot];
    }
    function getMM(obj, name) {
        if (typeof obj === "string" && env.__string_mt) {
            const smt = env.__string_mt;
            if (smt[name] !== undefined)
                return smt[name];
        }
        if (obj && typeof obj === "object" && obj.__metatable) {
            const mt = obj.__metatable;
            if (mt && typeof mt === "object" && mt[name] !== undefined) {
                return mt[name];
            }
        }
        return undefined;
    }
    function arithMM(a, b, op, name) {
        if (typeof a === "number" && typeof b === "number")
            return op(a, b);
        const mm = getMM(a, name) ?? getMM(b, name);
        if (typeof mm === "function")
            return mm(a, b);
        const na = typeof a === "string" ? Number(a) : a;
        const nb = typeof b === "string" ? Number(b) : b;
        if (typeof na === "number" && !isNaN(na) && typeof nb === "number" && !isNaN(nb))
            return op(na, nb);
        return op(a, b);
    }
    function callFunc(f, args) {
        if (typeof f !== "function") {
            const mm = getMM(f, "__call");
            if (typeof mm === "function") {
                f = mm;
            }
            else
                throw new Error(`attempt to call a ${luaToString(f)} value`);
        }
        return f(...args);
    }
    while (ip < code.length) {
        if (onTick && ++tickCounter >= tickInterval) {
            tickCounter = 0;
            onTick();
        }
        const op = code[ip++];
        try {
            if (op === 1 /* Op.PUSH_NIL */)
                push(null);
            else if (op === 2 /* Op.PUSH_TRUE */)
                push(true);
            else if (op === 3 /* Op.PUSH_FALSE */)
                push(false);
            else if (op === 4 /* Op.PUSH_K */)
                push(K[code[ip++]]);
            else if (op === 5 /* Op.LOAD_L */)
                push(getLocal(code[ip++]));
            else if (op === 6 /* Op.STORE_L */)
                setLocal(code[ip++], pop());
            else if (op === 7 /* Op.LOAD_G */) {
                const name = K[code[ip++]];
                const val = env[name];
                push(val !== undefined ? val : null);
            }
            else if (op === 8 /* Op.STORE_G */) {
                env[K[code[ip++]]] = pop();
            }
            else if (op === 9 /* Op.ADD */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => x + y, "__add"));
            }
            else if (op === 10 /* Op.SUB */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => x - y, "__sub"));
            }
            else if (op === 11 /* Op.MUL */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => x * y, "__mul"));
            }
            else if (op === 12 /* Op.DIV */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => x / y, "__div"));
            }
            else if (op === 13 /* Op.MOD */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => x % y, "__mod"));
            }
            else if (op === 14 /* Op.POW */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => Math.pow(x, y), "__pow"));
            }
            else if (op === 15 /* Op.CONCAT */) {
                const b = pop();
                const a = pop();
                const mm = getMM(a, "__concat") ?? getMM(b, "__concat");
                if (typeof mm === "function")
                    push(mm(a, b));
                else
                    push(luaToString(a) + luaToString(b));
            }
            else if (op === 16 /* Op.EQ */) {
                const b = pop();
                const a = pop();
                if (a === b) {
                    push(true);
                }
                else {
                    const mm = getMM(a, "__eq");
                    if (typeof mm === "function")
                        push(mm(a, b) === true);
                    else
                        push(a === b);
                }
            }
            else if (op === 17 /* Op.NE */) {
                const b = pop();
                const a = pop();
                if (a === b) {
                    push(false);
                }
                else {
                    const mm = getMM(a, "__eq");
                    if (typeof mm === "function")
                        push(mm(a, b) !== true);
                    else
                        push(a !== b);
                }
            }
            else if (op === 18 /* Op.LT */) {
                const b = pop();
                const a = pop();
                const mm = getMM(a, "__lt") ?? getMM(b, "__lt");
                if (typeof mm === "function")
                    push(mm(a, b) === true);
                else if (typeof a === "string" && typeof b === "string")
                    push(a < b);
                else
                    push(a < b);
            }
            else if (op === 19 /* Op.LE */) {
                const b = pop();
                const a = pop();
                const mm = getMM(a, "__le") ?? getMM(b, "__le");
                if (typeof mm === "function")
                    push(mm(a, b) === true);
                else if (typeof a === "string" && typeof b === "string")
                    push(a <= b);
                else
                    push(a <= b);
            }
            else if (op === 20 /* Op.GT */) {
                const b = pop();
                const a = pop();
                const mm = getMM(b, "__lt") ?? getMM(a, "__lt");
                if (typeof mm === "function")
                    push(mm(b, a) === true);
                else if (typeof a === "string" && typeof b === "string")
                    push(a > b);
                else
                    push(a > b);
            }
            else if (op === 21 /* Op.GE */) {
                const b = pop();
                const a = pop();
                const mm = getMM(b, "__le") ?? getMM(a, "__le");
                if (typeof mm === "function")
                    push(mm(b, a) === true);
                else if (typeof a === "string" && typeof b === "string")
                    push(a >= b);
                else
                    push(a >= b);
            }
            else if (op === 22 /* Op.AND */) {
                const b = pop();
                const a = pop();
                push(isTruthy(a) ? b : a);
            }
            else if (op === 23 /* Op.OR */) {
                const b = pop();
                const a = pop();
                push(isTruthy(a) ? a : b);
            }
            else if (op === 24 /* Op.NOT */) {
                push(!isTruthy(pop()));
            }
            else if (op === 25 /* Op.UNM */) {
                const v = pop();
                const mm = getMM(v, "__unm");
                if (typeof mm === "function")
                    push(mm(v));
                else
                    push(-v);
            }
            else if (op === 26 /* Op.LEN */) {
                const v = pop();
                const mm = getMM(v, "__len");
                if (typeof mm === "function") {
                    push(mm(v));
                }
                else
                    push(luaLen(v));
            }
            else if (op === 27 /* Op.NEW_TABLE */)
                push({});
            else if (op === 28 /* Op.GET_TABLE */) {
                const keyVal = pop();
                const tbl = pop();
                if (tbl === null || tbl === undefined) {
                    throw new Error(`attempt to index nil with '${luaToString(keyVal)}'`);
                }
                if (typeof tbl === "string") {
                    const strLib = env.string;
                    if (strLib && strLib[keyVal] !== undefined) {
                        push(strLib[keyVal]);
                    }
                    else {
                        push(undefined);
                    }
                }
                else if (typeof tbl === "object") {
                    const raw = tbl[keyVal];
                    if (raw !== undefined) {
                        push(raw);
                    }
                    else {
                        const mm = getMM(tbl, "__index");
                        if (typeof mm === "function")
                            push(mm(tbl, keyVal));
                        else if (mm && typeof mm === "object")
                            push(mm[keyVal] ?? null);
                        else
                            push(null);
                    }
                }
                else {
                    try {
                        push(tbl[keyVal]);
                    }
                    catch {
                        push(null);
                    }
                }
            }
            else if (op === 29 /* Op.SET_TABLE */) {
                const v = pop();
                const k = pop();
                const t = pop();
                if (t === null || t === undefined) {
                    throw new Error(`attempt to index nil with '${luaToString(k)}'`);
                }
                if (typeof t === "object") {
                    const existing = t[k];
                    if (existing !== undefined) {
                        t[k] = v;
                    }
                    else {
                        const mm = getMM(t, "__newindex");
                        if (typeof mm === "function")
                            mm(t, k, v);
                        else if (mm && typeof mm === "object")
                            mm[k] = v;
                        else
                            t[k] = v;
                    }
                }
                else {
                    t[k] = v;
                }
            }
            else if (op === 30 /* Op.CALL */) {
                const n = code[ip++];
                const args = [];
                for (let j = 0; j < n; j++)
                    args.unshift(pop());
                const f = pop();
                const ret = callFunc(f, args);
                if (Array.isArray(ret)) {
                    push(ret.length > 0 ? ret[0] : null);
                }
                else {
                    push(ret !== undefined ? ret : null);
                }
            }
            else if (op === 31 /* Op.RETURN */) {
                const n = code[ip++];
                if (n === 0)
                    return undefined;
                let cnt = n < 0 ? stackTop : n;
                if (cnt > stackTop)
                    cnt = stackTop;
                if (cnt === 0)
                    return undefined;
                if (cnt === 1)
                    return pop();
                const results = [];
                for (let j = 0; j < cnt; j++)
                    results.unshift(pop());
                return results;
            }
            else if (op === 32 /* Op.JMP */) {
                ip = code[ip];
            }
            else if (op === 33 /* Op.JMP_F */) {
                const target = code[ip++];
                const val = pop();
                if (!isTruthy(val))
                    ip = target;
            }
            else if (op === 34 /* Op.POP */) {
                const n = code[ip++];
                for (let j = 0; j < n; j++)
                    pop();
            }
            else if (op === 35 /* Op.CLOSURE */) {
                const pi = code[ip++];
                const P = protos[pi - 1];
                if (P) {
                    const closureEnv = env;
                    const closureUpvalues = {};
                    if (P.upvalues) {
                        for (let ui = 0; ui < P.upvalues.length; ui++) {
                            const [isLocal, idx] = P.upvalues[ui];
                            if (isLocal === 1) {
                                closureUpvalues[ui] = boxLocal(idx);
                            }
                            else {
                                closureUpvalues[ui] = upvalues[idx] || [null];
                            }
                        }
                    }
                    const nParams = P.nParams || 0;
                    const closureOptions = options;
                    push(function (...args) {
                        const L = {};
                        for (let j = 0; j < Math.min(args.length, nParams); j++)
                            L[j] = args[j];
                        const va = [];
                        for (let j = nParams; j < args.length; j++)
                            va.push(args[j]);
                        return runVM(P.K, P.code, closureEnv, 0, P.protos || [], L, closureUpvalues, va, closureOptions);
                    });
                }
                else {
                    push(null);
                }
            }
            else if (op === 36 /* Op.DUP */)
                push(top());
            else if (op === 37 /* Op.LOAD_UPVAL */) {
                const ui = code[ip++];
                const box = upvalues[ui];
                push(box ? box[0] : null);
            }
            else if (op === 38 /* Op.STORE_UPVAL */) {
                const ui = code[ip++];
                const box = upvalues[ui];
                if (box) {
                    box[0] = pop();
                }
                else {
                    pop();
                }
            }
            else if (op === 39 /* Op.CALL_MULTI */) {
                let n = code[ip++];
                const nrets = code[ip++];
                if (n < 0)
                    n = 0;
                const args = [];
                for (let j = 0; j < n; j++)
                    args.unshift(pop());
                const f = pop();
                const ret = callFunc(f, args);
                const results = Array.isArray(ret) ? ret : (ret !== undefined && ret !== null ? [ret] : []);
                if (nrets < 0) {
                    for (const r of results)
                        push(r);
                }
                else {
                    for (let j = 0; j < nrets; j++)
                        push(j < results.length ? results[j] : null);
                }
            }
            else if (op === 40 /* Op.LOAD_VARARG */) {
                const n = code[ip++];
                if (n < 0) {
                    for (const v of varargs)
                        push(v);
                }
                else {
                    for (let j = 0; j < n; j++)
                        push(j < varargs.length ? varargs[j] : null);
                }
            }
            else if (op === 41 /* Op.TAILCALL */) {
                const n = code[ip++];
                const args = [];
                for (let j = 0; j < n; j++)
                    args.unshift(pop());
                const f = pop();
                return callFunc(f, args);
            }
            else if (op === 44 /* Op.CONCAT_MULTI */) {
                const n = code[ip++];
                const parts = [];
                for (let j = 0; j < n; j++)
                    parts.unshift(luaToString(pop()));
                push(parts.join(""));
            }
            else if (op === 45 /* Op.PUSH_NILS */) {
                const n = code[ip++];
                for (let j = 0; j < n; j++)
                    push(null);
            }
            else if (op === 46 /* Op.MARK */) {
                callBaseStackTop++;
                callBasesStack[callBaseStackTop] = stackTop;
            }
            else if (op === 47 /* Op.CALL_DYNAMIC */) {
                const nrets = code[ip++];
                let base = 0;
                if (callBaseStackTop > 0) {
                    base = callBasesStack[callBaseStackTop] ?? 0;
                    callBaseStackTop--;
                }
                let totalArgs = stackTop - base - 1;
                if (totalArgs < 0)
                    totalArgs = 0;
                const args = [];
                for (let j = 0; j < totalArgs; j++)
                    args.unshift(pop());
                const f = pop();
                const ret = callFunc(f, args);
                const results = Array.isArray(ret) ? ret : (ret !== undefined && ret !== null ? [ret] : []);
                if (nrets < 0) {
                    for (const r of results)
                        push(r);
                }
                else {
                    for (let j = 0; j < nrets; j++)
                        push(j < results.length ? results[j] : null);
                }
            }
            else if (op === 48 /* Op.IDIV */) {
                const b = pop();
                const a = pop();
                push(arithMM(a, b, (x, y) => Math.floor(x / y), "__idiv"));
            }
            else if (op === 49 /* Op.CLOSE_UPVAL */) {
                const slot = code[ip++];
                if (localBoxes[slot]) {
                    delete localBoxes[slot];
                }
            }
            else if (op === 50 /* Op.SETLIST */) {
                const startIdx = code[ip++];
                let base = 0;
                if (callBaseStackTop > 0) {
                    base = callBasesStack[callBaseStackTop] ?? 0;
                    callBaseStackTop--;
                }
                const tbl = stack[base - 1];
                const numValues = stackTop - base;
                for (let i = 0; i < numValues; i++) {
                    tbl[startIdx + i] = stack[base + i];
                }
                for (let i = base; i < stackTop; i++)
                    stack[i] = undefined;
                stackTop = base;
            }
            else if (op === 51 /* Op.SWAP */) {
                const b = pop();
                const a = pop();
                push(b);
                push(a);
            }
            else if (op === 52 /* Op.NAMECALL */) {
                const nameIdx = code[ip++];
                const methodName = K[nameIdx];
                const obj = pop();
                if (obj === null || obj === undefined) {
                    throw new Error(`attempt to index nil with '${methodName}'`);
                }
                let method;
                if (typeof obj === "string") {
                    const strLib = env.string;
                    method = strLib ? strLib[methodName] : undefined;
                }
                else {
                    method = obj[methodName];
                    if (method === undefined) {
                        const mm = getMM(obj, "__index");
                        if (typeof mm === "function")
                            method = mm(obj, methodName);
                        else if (mm && typeof mm === "object")
                            method = mm[methodName];
                    }
                }
                push(obj);
                push(method);
                const b2 = pop();
                const a2 = pop();
                push(b2);
                push(a2);
            }
            else if (op === 53 /* Op.TFOR */) {
                const nVars = code[ip++];
                const target = code[ip++];
                const control = pop();
                const state = pop();
                const iter = pop();
                const results = iter(state, control);
                const resArr = Array.isArray(results) ? results : (results !== undefined && results !== null ? [results] : []);
                if (resArr.length === 0 || resArr[0] === null || resArr[0] === undefined) {
                    ip = target;
                }
                else {
                    for (let i = nVars - 1; i >= 0; i--)
                        push(i < resArr.length ? resArr[i] : null);
                    push(iter);
                    push(state);
                    push(resArr[0]);
                }
            }
            else if (op === 54 /* Op.PCALL */) {
                const nArgs = code[ip++];
                const args = [];
                for (let j = 0; j < nArgs; j++)
                    args.unshift(pop());
                const f = pop();
                try {
                    const ret = callFunc(f, args);
                    const results = Array.isArray(ret) ? ret : (ret !== undefined && ret !== null ? [ret] : []);
                    push(true);
                    for (const r of results)
                        push(r);
                }
                catch (e) {
                    push(false);
                    push(e instanceof Error ? e.message : String(e));
                }
            }
            else if (op === 55 /* Op.XPCALL */) {
                const nArgs = code[ip++];
                const args = [];
                for (let j = 0; j < nArgs; j++)
                    args.unshift(pop());
                const handler = pop();
                const f = pop();
                try {
                    const ret = callFunc(f, args);
                    const results = Array.isArray(ret) ? ret : (ret !== undefined && ret !== null ? [ret] : []);
                    push(true);
                    for (const r of results)
                        push(r);
                }
                catch (e) {
                    push(false);
                    try {
                        const handlerResult = callFunc(handler, [e instanceof Error ? e.message : String(e)]);
                        push(handlerResult);
                    }
                    catch {
                        push(e instanceof Error ? e.message : String(e));
                    }
                }
            }
            else if (op === 42 /* Op.FORPREP */) {
                const target = code[ip++];
                ip = target;
            }
            else if (op === 43 /* Op.FORLOOP */) {
                const target = code[ip++];
                ip = target;
            }
            else {
            }
        }
        catch (err) {
            if (err instanceof Error && err.message.includes("Timeout"))
                throw err;
            if (err instanceof Error && !err.message.includes("[op=")) {
                throw new Error(`${err.message} [op=${op} ip=${ip - 1}]`);
            }
            throw err;
        }
    }
    return undefined;
}
//# sourceMappingURL=vm-runner.js.map