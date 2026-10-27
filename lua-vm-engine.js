// VoidedX VM engine.
//
// Compiles Luau source to register bytecode (lua-vm-compiler.js), serializes it
// into a binary program, compresses and encrypts it, and emits a Lua script
// that decodes the program in memory and executes it on a custom interpreter.
//
// There is no `loadstring` of user code anywhere in the output: the original
// text is gone the moment compilation finishes, string constants live inside
// the encrypted blob, and control flow exists only as bytecode.

import { compileLua, VM_OPS } from './lua-vm-compiler.js';
import {
    addPass, adler32, base64Encode, buildDeadFunctions, createNameFactory, createRng,
    lzssCompress, randomInt, shuffleAlphabet, splitSegments, weightedSum
} from './lua-vm-codec.js';

export const VM_ENGINE_VERSION = 3;

const LEVEL_CONFIG = Object.freeze({
    fast: { segments: 5, depth: 14, dead: 0, checks: 0, layers: 1 },
    low: { segments: 7, depth: 22, dead: 1, checks: 1, layers: 1 },
    medium: { segments: 10, depth: 40, dead: 2, checks: 1, layers: 1 },
    high: { segments: 14, depth: 64, dead: 3, checks: 2, layers: 2 },
    absolute: { segments: 18, depth: 96, dead: 4, checks: 3, layers: 2 }
});

const FLUSH_BYTES = 192;

class ByteWriter {
    constructor() {
        this.bytes = new Uint8Array(1024);
        this.length = 0;
    }

    ensure(extra) {
        if (this.length + extra <= this.bytes.length) return;
        let size = this.bytes.length * 2;
        while (size < this.length + extra) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.bytes.subarray(0, this.length));
        this.bytes = next;
    }

    u8(value) {
        this.ensure(1);
        this.bytes[this.length++] = value & 0xff;
    }

    u16(value) {
        this.ensure(2);
        this.bytes[this.length++] = value & 0xff;
        this.bytes[this.length++] = (value >>> 8) & 0xff;
    }

    u24(value) {
        this.ensure(3);
        this.bytes[this.length++] = value & 0xff;
        this.bytes[this.length++] = (value >>> 8) & 0xff;
        this.bytes[this.length++] = (value >>> 16) & 0xff;
    }

    u32(value) {
        this.ensure(4);
        this.bytes[this.length++] = value & 0xff;
        this.bytes[this.length++] = (value >>> 8) & 0xff;
        this.bytes[this.length++] = (value >>> 16) & 0xff;
        this.bytes[this.length++] = (value >>> 24) & 0xff;
    }

    f64(value) {
        this.ensure(8);
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setFloat64(0, value, true);
        const raw = new Uint8Array(buffer);
        for (let i = 0; i < 8; i++) this.bytes[this.length++] = raw[i];
    }

    raw(bytes) {
        this.ensure(bytes.length);
        this.bytes.set(bytes, this.length);
        this.length += bytes.length;
    }

    take() {
        return this.bytes.slice(0, this.length);
    }
}

function stringToBytes(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value);
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
    return bytes;
}

export function serializeProgram(program, opcodeNumbers) {
    const writer = new ByteWriter();
    writer.u8(0x56);
    writer.u8(0x58);
    writer.u8(0x56);
    writer.u8(0x31);
    writer.u8(1);
    writer.u16(program.root);
    writer.u16(program.protos.length);

    for (const proto of program.protos) {
        writer.u8(proto.np);
        writer.u8(proto.va ? 1 : 0);
        writer.u8(proto.ms);
        writer.u32(proto.code.length);
        for (const instr of proto.code) {
            const opcode = opcodeNumbers[instr.op];
            if (opcode === undefined) throw new Error(`internal: unknown opcode ${instr.op}`);
            if (instr.a > 0xff) throw new Error('internal: operand A out of range');
            if (instr.b > 0xffffff || instr.c > 0xffffff) throw new Error('internal: operand out of range');
            writer.u8(opcode);
            writer.u8(instr.a);
            writer.u24(instr.b);
            writer.u24(instr.c);
        }
        writer.u32(proto.consts.length);
        for (const value of proto.consts) {
            if (value === undefined || value === null) {
                writer.u8(0);
            } else if (value === false) {
                writer.u8(1);
            } else if (value === true) {
                writer.u8(2);
            } else if (typeof value === 'number') {
                if (Number.isInteger(value) && Math.abs(value) <= 9007199254740991) {
                    // Preserve Lua's integer subtype so arithmetic and tostring
                    // match the original script on 5.3+ engines.
                    writer.u8(5);
                    const negative = value < 0;
                    const magnitude = Math.abs(value);
                    const high = Math.floor(magnitude / 4294967296);
                    writer.u8(negative ? 1 : 0);
                    writer.u32(magnitude - high * 4294967296);
                    writer.u32(high);
                } else {
                    writer.u8(3);
                    writer.f64(value);
                }
            } else if (typeof value === 'string') {
                writer.u8(4);
                const bytes = stringToBytes(value);
                writer.u32(bytes.length);
                writer.raw(bytes);
            } else {
                throw new Error('internal: unsupported constant type');
            }
        }
        writer.u8(proto.upvals.length);
        for (const upval of proto.upvals) {
            writer.u8(upval.fromParent ? 1 : 0);
            writer.u8(upval.index);
        }
    }

    return writer.take();
}

function shuffledOpcodeNumbers(rng) {
    const numbers = VM_OPS.map((_, index) => index);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        const tmp = numbers[i];
        numbers[i] = numbers[j];
        numbers[j] = tmp;
    }
    const map = {};
    VM_OPS.forEach((name, index) => {
        map[name] = numbers[index];
    });
    return map;
}

const HANDLERS = {
    MOVE: p => `${p.R}[a]=${p.R}[b]`,
    LOADK: p => `${p.R}[a]=${p.K}[b+1]`,
    LOADNIL: p => `for i=0,b-1 do ${p.R}[a+i]=nil end`,
    LOADBOOL: p => `${p.R}[a]=b~=0`,
    NEWTABLE: p => `${p.R}[a]={}`,
    NEWCELL: p => `${p.R}[a]={nil}`,
    CELLGET: p => `${p.R}[a]=${p.R}[b][1]`,
    CELLSET: p => `${p.R}[b][1]=${p.R}[a]`,
    GETUP: p => `${p.R}[a]=${p.U}[b+1][1]`,
    SETUP: p => `${p.U}[b+1][1]=${p.R}[a]`,
    GETTAB: p => `${p.R}[a]=${p.R}[b][${p.R}[c]]`,
    SETTAB: p => `${p.R}[a][${p.R}[b]]=${p.R}[c]`,
    GETTABK: p => `${p.R}[a]=${p.R}[b][${p.K}[c+1]]`,
    SETTABK: p => `${p.R}[a][${p.K}[b+1]]=${p.R}[c]`,
    SELF: p => `${p.R}[a+1]=${p.R}[b];${p.R}[a]=${p.R}[b][${p.K}[c+1]]`,
    ADD: p => `${p.R}[a]=${p.R}[b]+${p.R}[c]`,
    SUB: p => `${p.R}[a]=${p.R}[b]-${p.R}[c]`,
    MUL: p => `${p.R}[a]=${p.R}[b]*${p.R}[c]`,
    DIV: p => `${p.R}[a]=${p.R}[b]/${p.R}[c]`,
    MOD: p => `${p.R}[a]=${p.R}[b]%${p.R}[c]`,
    POW: p => `${p.R}[a]=${p.R}[b]^${p.R}[c]`,
    IDIV: p => `${p.R}[a]=${p.floor}(${p.R}[b]/${p.R}[c])`,
    BAND: p => `${p.R}[a]=${p.R}[b]&${p.R}[c]`,
    BOR: p => `${p.R}[a]=${p.R}[b]|${p.R}[c]`,
    BXOR: p => `${p.R}[a]=${p.R}[b]~${p.R}[c]`,
    SHL: p => `${p.R}[a]=${p.R}[b]<<${p.R}[c]`,
    SHR: p => `${p.R}[a]=${p.R}[b]>>${p.R}[c]`,
    CAT: p => `${p.R}[a]=${p.R}[b]..${p.R}[c]`,
    UNM: p => `${p.R}[a]=-${p.R}[b]`,
    NOT: p => `${p.R}[a]=not ${p.R}[b]`,
    LEN: p => `${p.R}[a]=#${p.R}[b]`,
    BNOT: p => `${p.R}[a]=~${p.R}[b]`,
    EQ: p => `${p.R}[a]=${p.R}[b]==${p.R}[c]`,
    LT: p => `${p.R}[a]=${p.R}[b]<${p.R}[c]`,
    LE: p => `${p.R}[a]=${p.R}[b]<=${p.R}[c]`,
    JMP: p => `${p.pc}=b*8+1`,
    JMPIF: p => `local v=${p.R}[a];if v~=nil and v~=false then ${p.pc}=b*8+1 end`,
    JMPIFNOT: p => `local v=${p.R}[a];if v==nil or v==false then ${p.pc}=b*8+1 end`,
    JMPNIL: p => `if ${p.R}[a]==nil then ${p.pc}=b*8+1 end`,
    CALL: p => `local f=${p.R}[a] local res if b>0 then res=${p.pack}(f(${p.unpack}(${p.R},a+1,a+b))) else res=${p.pack}(f()) end `
        + `local rn=res.n if c==0 then ${p.top}=a+rn for i=1,rn do ${p.R}[a+i-1]=res[i] end `
        + `else for i=1,c do ${p.R}[a+i-1]=res[i] end end`,
    CALLV: p => `local f=${p.R}[a] local res=${p.pack}(f(${p.unpack}(${p.R},a+1,${p.top}-1))) `
        + `local rn=res.n if c==0 then ${p.top}=a+rn for i=1,rn do ${p.R}[a+i-1]=res[i] end `
        + `else for i=1,c do ${p.R}[a+i-1]=res[i] end end`,
    RETURN: p => `if b==0 then return ${p.unpack}(${p.R},a,${p.top}-1) end return ${p.unpack}(${p.R},a,a+b-1)`,
    RET0: () => 'return',
    VARARG: p => `if b==0 then ${p.top}=a+${p.vn} for i=1,${p.vn} do ${p.R}[a+i-1]=${p.V}[i] end `
        + `else for i=1,b do ${p.R}[a+i-1]=${p.V}[i] end end`,
    CLOSURE: p => `local pr=${p.protos}[b+1] local ud=pr[6] local u={} `
        + `for i=1,#ud do local d=ud[i] if d[1]==1 then u[i]=${p.R}[d[2]] else u[i]=${p.U}[d[2]] end end `
        + `local cl={pr,u} ${p.R}[a]=function(...) return ${p.run}(cl,...) end`,
    FORPREP: p => `local init,limit,step=${p.tonum}(${p.R}[a]),${p.tonum}(${p.R}[a+1]),${p.tonum}(${p.R}[a+2]) `
        + `if not init or not limit or not step then ${p.error}("'for' limit must be a number",0) end `
        + `if step==0 then ${p.error}("'for' step is zero",0) end `
        + `${p.R}[a],${p.R}[a+1],${p.R}[a+2]=init,limit,step `
        + `if (step>0 and init>limit) or (step<0 and init<limit) then ${p.pc}=b*8+1 else ${p.R}[a+3]=init end`,
    FORLOOP: p => `local idx=${p.R}[a]+${p.R}[a+2] ${p.R}[a]=idx local step,limit=${p.R}[a+2],${p.R}[a+1] `
        + `if (step>0 and idx<=limit) or (step<0 and idx>=limit) then ${p.R}[a+3]=idx ${p.pc}=b*8+1 end`,
    ITERPREP: p => `local f=${p.R}[a] if ${p.type}(f)=="table" then local mt=${p.getmt}(f) `
        + `local it=mt and ${p.rawget}(mt,"__iter") `
        + `if it then local fn=it(f) ${p.R}[a]=function(...) return fn(...) end ${p.R}[a+1]=nil ${p.R}[a+2]=nil `
        + `elseif not (mt and ${p.rawget}(mt,"__call")) then ${p.R}[a]=${p.nextf} ${p.R}[a+1]=f ${p.R}[a+2]=nil end `
        + `elseif ${p.type}(f)~="function" then ${p.error}("attempt to iterate over a "..${p.type}(f).." value",0) end`,
    ITERCALL: p => `local f=${p.R}[a] if b==2 then local x,y=f(${p.R}[a+1],${p.R}[a+2]) ${p.R}[a+3]=x ${p.R}[a+4]=y `
        + `elseif b==1 then ${p.R}[a+3]=f(${p.R}[a+1],${p.R}[a+2]) `
        + `else local res=${p.pack}(f(${p.R}[a+1],${p.R}[a+2])) for i=1,b do ${p.R}[a+2+i]=res[i] end end`,
    SETLIST: p => `local t=${p.R}[a] for i=0,${p.top}-c-1 do t[b+i]=${p.R}[c+i] end`,
    GETGLOBAL: p => `${p.R}[a]=${p.ENV}[${p.K}[b+1]]`,
    SETGLOBAL: p => `${p.ENV}[${p.K}[b+1]]=${p.R}[a]`
};

function buildInterpreter(o) {
    const lines = [];
    const p = o.names;
    lines.push(`local function ${p.run}(${p.cl},...)`);
    lines.push(`    local ${p.P}=${p.cl}[1]`);
    lines.push(`    local ${p.U}=${p.cl}[2]`);
    lines.push(`    local ${p.code}=${p.P}[4]`);
    lines.push(`    local ${p.K}=${p.P}[5]`);
    lines.push(`    local ${p.R}=${p.pack}(...)`);
    lines.push(`    local ${p.np}=${p.P}[1]`);
    lines.push(`    local ${p.vn}=0`);
    lines.push(`    local ${p.V}={}`);
    lines.push(`    if ${p.P}[2]==1 then`);
    lines.push(`        ${p.vn}=${p.R}.n-${p.np}`);
    lines.push(`        if ${p.vn}<0 then ${p.vn}=0 end`);
    lines.push(`        for i=1,${p.vn} do ${p.V}[i]=${p.R}[${p.np}+i] end`);
    lines.push('    end');
    lines.push(`    local ${p.top}=${p.R}.n+1`);
    lines.push(`    local ${p.pc}=1`);
    lines.push('    while true do');
    lines.push(`        local op,a,b1,b2,b3,c1,c2,c3=${p.byte}(${p.code},${p.pc},${p.pc}+7)`);
    lines.push('        local b=b1+b2*256+b3*65536');
    lines.push('        local c=c1+c2*256+c3*65536');
    lines.push(`        ${p.pc}=${p.pc}+8`);

    const order = o.handlers.slice().sort(() => o.rng() - 0.5);
    lines.push(`        if op==${order[0].number} then`);
    lines.push(`            ${order[0].body}`);
    for (let index = 1; index < order.length; index++) {
        lines.push(`        elseif op==${order[index].number} then`);
        lines.push(`            ${order[index].body}`);
    }
    lines.push('        else');
    lines.push(`            return ${p.error}("[VoidedX] The protected program is corrupt.",0)`);
    lines.push('        end');
    lines.push('    end');
    lines.push('end');
    return lines.join('\n');
}

function buildRuntime(o) {
    const p = o.names;
    const lines = [];
    const guard = o.tamper;

    lines.push(`local ${p.unpack}=table.unpack or unpack`);
    lines.push(`local ${p.concat}=table.concat`);
    lines.push(`local ${p.byte},${p.char},${p.sub},${p.slen}=string.byte,string.char,string.sub,string.len`);
    lines.push(`local ${p.floor}=math.floor`);
    lines.push(`local ${p.type}=type`);
    lines.push(`local ${p.getmt}=getmetatable`);
    lines.push(`local ${p.rawget}=rawget`);
    lines.push(`local ${p.tonum}=tonumber`);
    lines.push(`local ${p.nextf}=next`);
    lines.push(`local ${p.error}=error`);
    lines.push(`local ${p.pcall}=pcall`);
    lines.push(`local ${p.rawequal}=rawequal`);
    lines.push(`local ${p.debug}=debug`);
    lines.push(`local ${p.pack}=table.pack or function(...) return {n=select("#",...),...} end`);
    lines.push(`local ${p.ENV}`);
    lines.push('if getfenv then');
    lines.push(`    local ok,env=${p.pcall}(getfenv,0)`);
    lines.push(`    if ok and ${p.type}(env)=="table" then ${p.ENV}=env end`);
    lines.push('end');
    lines.push(`${p.ENV}=${p.ENV} or _G`);
    lines.push(`if ${p.type}(${p.ENV})~="table" then return ${p.error}("[VoidedX] This executor does not expose a script environment.",0) end`);
    lines.push('');

    lines.push(`local ${p.checkFn}=function()`);
    lines.push(`    if string.byte~=${p.byte} or string.char~=${p.char} or string.sub~=${p.sub} or string.len~=${p.slen} then return false end`);
    lines.push(`    if table.concat~=${p.concat} then return false end`);
    lines.push(`    if rawequal~=${p.rawequal} then return false end`);
    lines.push(`    if ${p.type}(table.pack)~="function" and ${p.type}(${p.pack})~="function" then return false end`);
    if (o.hookGuard) {
        lines.push(`    if ${p.type}(${p.debug})=="table" and ${p.type}(debug.gethook)=="function" then`);
        lines.push(`        local ok,hook=${p.pcall}(debug.gethook)`);
        lines.push(`        if ok and hook~=nil then return false end`);
        lines.push('    end');
    }
    lines.push('    return true');
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.map}={}`);
    lines.push('do');
    lines.push(`    local alpha="${o.alphabet}"`);
    lines.push('    local i=1');
    lines.push(`    while i<=64 do ${p.map}[${p.byte}(alpha,i)]=i-1 i=i+1 end`);
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.b64}=function(s)`);
    lines.push(`    local n=${p.slen}(s)`);
    lines.push('    local out={}');
    lines.push('    local on=0');
    lines.push('    local buf={}');
    lines.push('    local bn=0');
    lines.push('    local i=1');
    lines.push('    while i<=n do');
    lines.push(`        local c1=${p.map}[${p.byte}(s,i)] or 0`);
    lines.push(`        local c2=${p.map}[${p.byte}(s,i+1)] or 0`);
    lines.push(`        local c3=${p.map}[${p.byte}(s,i+2)] or 0`);
    lines.push(`        local c4=${p.map}[${p.byte}(s,i+3)] or 0`);
    lines.push('        local v=c1*262144+c2*4096+c3*64+c4');
    lines.push(`        bn=bn+1 buf[bn]=${p.floor}(v/65536)%256`);
    lines.push(`        if i+2<=n then bn=bn+1 buf[bn]=${p.floor}(v/256)%256 end`);
    lines.push('        if i+3<=n then bn=bn+1 buf[bn]=v%256 end');
    lines.push(`        if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) buf={} bn=0 end`);
    lines.push('        i=i+4');
    lines.push('    end');
    lines.push(`    if bn>0 then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) end`);
    lines.push(`    return ${p.concat}(out)`);
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.xor}=function(s,key)`);
    lines.push(`    local n=${p.slen}(s)`);
    lines.push('    local out={}');
    lines.push('    local on=0');
    lines.push('    local buf={}');
    lines.push('    local bn=0');
    lines.push('    local st=key%4294967296');
    lines.push('    local i=1');
    lines.push('    while i<=n do');
    lines.push(`        local ch=${p.byte}(s,i)`);
    lines.push('        st=(st*1664525+1013904223)%4294967296');
    lines.push(`        bn=bn+1 buf[bn]=(ch-${p.floor}(st/16777216)%256)%256`);
    lines.push(`        if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) buf={} bn=0 end`);
    lines.push('        i=i+1');
    lines.push('    end');
    lines.push(`    if bn>0 then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) end`);
    lines.push(`    return ${p.concat}(out)`);
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.inflate}=function(s)`);
    lines.push(`    local n=${p.slen}(s)`);
    lines.push('    local out={}');
    lines.push('    local on=0');
    lines.push('    local win={}');
    lines.push('    local wpos=0');
    lines.push('    local produced=0');
    lines.push('    local buf={}');
    lines.push('    local bn=0');
    lines.push('    local i=1');
    lines.push('    while i<=n do');
    lines.push(`        local c=${p.byte}(s,i)`);
    lines.push('        i=i+1');
    lines.push('        if c<128 then');
    lines.push('            local stop=i+c+1');
    lines.push('            while i<stop do');
    lines.push(`                local v=${p.byte}(s,i)`);
    lines.push('                i=i+1');
    lines.push('                bn=bn+1 buf[bn]=v');
    lines.push('                win[wpos]=v');
    lines.push('                wpos=wpos+1');
    lines.push('                if wpos==65536 then wpos=0 end');
    lines.push('                produced=produced+1');
    lines.push(`                if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) buf={} bn=0 end`);
    lines.push('            end');
    lines.push('        else');
    lines.push('            local len=c-125');
    lines.push(`            local lo=${p.byte}(s,i) or 0`);
    lines.push(`            local hi=${p.byte}(s,i+1) or 0`);
    lines.push('            i=i+2');
    lines.push('            local off=lo+hi*256');
    lines.push('            if off<1 or off>produced or len<=0 then return nil end');
    lines.push('            local j=0');
    lines.push('            while j<len do');
    lines.push('                local v=win[(wpos-off)%65536]');
    lines.push('                bn=bn+1 buf[bn]=v');
    lines.push('                win[wpos]=v');
    lines.push('                wpos=wpos+1');
    lines.push('                if wpos==65536 then wpos=0 end');
    lines.push('                produced=produced+1');
    lines.push(`                if bn>=${FLUSH_BYTES} then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) buf={} bn=0 end`);
    lines.push('                j=j+1');
    lines.push('            end');
    lines.push('        end');
    lines.push('    end');
    lines.push(`    if bn>0 then on=on+1 out[on]=${p.char}(${p.unpack}(buf,1,bn)) end`);
    lines.push(`    return ${p.concat}(out)`);
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.adler}=function(s)`);
    lines.push(`    local n=${p.slen}(s)`);
    lines.push('    local a=1');
    lines.push('    local b=0');
    lines.push('    local i=1');
    lines.push('    while i<=n do');
    lines.push(`        a=(a+${p.byte}(s,i))%65521`);
    lines.push('        b=(b+a)%65521');
    lines.push('        i=i+1');
    lines.push('    end');
    lines.push('    return b*65536+a');
    lines.push('end');
    lines.push('');

    if (guard) {
        lines.push(`local ${p.sum2}=function(s)`);
        lines.push(`    local n=${p.slen}(s)`);
        lines.push('    local t=0');
        lines.push('    local i=1');
        lines.push('    while i<=n do');
        lines.push(`        t=(t+${p.byte}(s,i)*i)%4294967296`);
        lines.push('        i=i+1');
        lines.push('    end');
        lines.push(`    return t`);
        lines.push('end');
        lines.push('');
    }

    lines.push(`local ${p.segs}={`);
    for (const segment of o.segments) lines.push(`    "${segment}",`);
    lines.push('}');
    lines.push(`local ${p.progLen}=${o.compressedLength}`);
    lines.push(`local ${p.sum1}=${o.checksum1}`);
    if (guard) lines.push(`local ${p.sum3}=${o.checksum2}`);
    lines.push(`local ${p.keys}={${o.layerKeys.join(',')}}`);
    lines.push(`local ${p.protos}`);
    lines.push(`local ${p.root}`);
    lines.push('');

    lines.push(`local ${p.decode}=function()`);
    lines.push('    local parts={}');
    lines.push('    local i=1');
    lines.push(`    while i<=${o.segments.length} do parts[i]=${p.b64}(${p.segs}[i]) i=i+1 end`);
    lines.push(`    local data=${p.concat}(parts)`);
    lines.push('    parts=nil');
    lines.push('    local k=#' + p.keys);
    lines.push(`    while k>=1 do data=${p.xor}(data,${p.keys}[k]) k=k-1 end`);
    lines.push(`    if ${p.slen}(data)~=${p.progLen} then return nil end`);
    lines.push(`    if ${p.adler}(data)~=${p.sum1} then return nil end`);
    if (guard) lines.push(`    if ${p.sum2}(data)~=${p.sum3} then return nil end`);
    lines.push(`    local raw=${p.inflate}(data)`);
    lines.push('    data=nil');
    lines.push('    return raw');
    lines.push('end');
    lines.push('');

    lines.push(`local ${p.parse}=function(data)`);
    lines.push('    local pos=1');
    lines.push(`    local function u8() local v=${p.byte}(data,pos) pos=pos+1 return v or 0 end`);
    lines.push(`    local function u16() local x,y=${p.byte}(data,pos,pos+1) pos=pos+2 return (x or 0)+(y or 0)*256 end`);
    lines.push(`    local function u32() local x,y,z,w=${p.byte}(data,pos,pos+3) pos=pos+4 return (x or 0)+(y or 0)*256+(z or 0)*65536+(w or 0)*16777216 end`);
    lines.push(`    local function f64()`);
    lines.push(`        local b1,b2,b3,b4,b5,b6,b7,b8=${p.byte}(data,pos,pos+7)`);
    lines.push('        pos=pos+8');
    lines.push('        local sign=1');
    lines.push('        if b8>=128 then sign=-1 b8=b8-128 end');
    lines.push(`        local exp=b8*16+${p.floor}(b7/16)`);
    lines.push('        local mant=((((((b7%16)*256+b6)*256+b5)*256+b4)*256+b3)*256+b2)*256+b1');
    lines.push('        if exp==0 then');
    lines.push('            if mant==0 then return 0 end');
    lines.push('            return sign*mant*2^-1074');
    lines.push('        elseif exp==2047 then');
    lines.push('            if mant==0 then return sign*1/0 end');
    lines.push('            return 0/0');
    lines.push('        end');
    lines.push('        return sign*(1+mant/4503599627370496)*2^(exp-1023)');
    lines.push('    end');
    lines.push('    if u8()~=86 or u8()~=88 or u8()~=86 or u8()~=49 or u8()~=1 then return nil end');
    lines.push('    local root=u16()');
    lines.push('    local count=u16()');
    lines.push('    local protos={}');
    lines.push('    local pi=1');
    lines.push('    while pi<=count do');
    lines.push('        local np=u8()');
    lines.push('        local fl=u8()');
    lines.push('        local ms=u8()');
    lines.push('        local cl=u32()');
    lines.push(`        local code=${p.sub}(data,pos,pos+cl*8-1)`);
    lines.push('        pos=pos+cl*8');
    lines.push('        local kc=u32()');
    lines.push('        local ks={}');
    lines.push('        local ki=1');
    lines.push('        while ki<=kc do');
    lines.push('            local t=u8()');
    lines.push('            if t==0 then ks[ki]=nil');
    lines.push('            elseif t==1 then ks[ki]=false');
    lines.push('            elseif t==2 then ks[ki]=true');
    lines.push('            elseif t==3 then ks[ki]=f64()');
    lines.push('            elseif t==5 then');
    lines.push('                local sg=u8()');
    lines.push('                local lo=u32()');
    lines.push('                local hi=u32()');
    lines.push('                local num=lo+hi*4294967296');
    lines.push('                if sg==1 then num=-num end');
    lines.push('                ks[ki]=num');
    lines.push('            else');
    lines.push('                local l=u32()');
    lines.push(`                ks[ki]=${p.sub}(data,pos,pos+l-1)`);
    lines.push('                pos=pos+l');
    lines.push('            end');
    lines.push('            ki=ki+1');
    lines.push('        end');
    lines.push('        local uc=u8()');
    lines.push('        local us={}');
    lines.push('        local ui=1');
    lines.push('        while ui<=uc do');
    lines.push('            local from=u8()');
    lines.push('            local idx=u8()');
    lines.push('            us[ui]={from,idx}');
    lines.push('            ui=ui+1');
    lines.push('        end');
    lines.push('        protos[pi]={np,fl%2,ms,code,ks,us}');
    lines.push('        pi=pi+1');
    lines.push('    end');
    lines.push('    return protos,root');
    lines.push('end');
    lines.push('');

    lines.push(buildInterpreter({ names: p, handlers: o.handlers, rng: o.rng }));
    lines.push('');

    if (guard) {
        for (let i = 0; i < o.checks; i++) {
            lines.push(`if ${o.opaque[i].expr}~=${o.opaque[i].expected} then return end`);
        }
    }
    lines.push(`if not ${p.checkFn}() then return ${p.error}("[VoidedX] This session was blocked because the runtime environment was modified.",0) end`);
    lines.push(`local ${p.raw}=${p.decode}()`);
    lines.push(`if not ${p.raw} then return ${p.error}("[VoidedX] The protected script failed its integrity check. Run the loader again.",0) end`);
    lines.push(`${p.protos},${p.root}=${p.parse}(${p.raw})`);
    lines.push(`${p.raw}=nil`);
    lines.push(`if not ${p.protos} then return ${p.error}("[VoidedX] The protected payload could not be read.",0) end`);
    lines.push(`if not ${p.checkFn}() then return ${p.error}("[VoidedX] This session was blocked because the runtime environment was modified.",0) end`);
    lines.push(`local ${p.out}=${p.pack}(${p.run}({${p.protos}[${p.root}+1],{}},...))`);
    lines.push(`return ${p.unpack}(${p.out},1,${p.out}.n)`);
    lines.push('');

    return lines.join('\n');
}

function buildHeader() {
    return [
        '--[[',
        '    VoidedX Loader  [https://voided.vercel.app]',
        '    VoidedX Protection  •  protect your scripts at https://voided.vercel.app',
        '',
        '    This file was produced by the VoidedX virtual machine engine.',
        '    The original script is not contained in this file: it was compiled',
        '    into an encrypted bytecode program that only the bundled interpreter',
        '    can execute. Editing or instrumenting this file aborts the run.',
        ']]--',
        ''
    ].join('\n');
}

function makeOpaque(rng, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const a = 17 + randomInt(rng, 231);
        const b = 19 + randomInt(rng, 231);
        const c = 7 + randomInt(rng, 499);
        const m = 31 + randomInt(rng, 220);
        out.push({ expr: `(${a}*${b}+${c})%${m}`, expected: (a * b + c) % m });
    }
    return out;
}

export function obfuscateVmSource(source, options = {}) {
    if (typeof source !== 'string' || source.trim() === '') {
        throw new Error('Paste a LuaU script before obfuscating it.');
    }
    const requested = options.level === 'auto' ? 'medium' : options.level;
    const level = LEVEL_CONFIG[requested] ? requested : 'medium';
    const preset = LEVEL_CONFIG[level];
    const rng = createRng();
    const nextName = createNameFactory(rng);

    const program = compileLua(source);
    const opcodeNumbers = shuffledOpcodeNumbers(rng);
    const binary = serializeProgram(program, opcodeNumbers);
    const compressed = lzssCompress(binary, preset.depth);

    let payload = compressed;
    const layerKeys = [];
    const layers = level === 'fast' ? 1 : preset.layers;
    for (let i = 0; i < layers; i++) {
        const key = randomInt(rng, 4294967296);
        layerKeys.push(key);
        payload = addPass(payload, key);
    }

    const alphabet = shuffleAlphabet(rng);
    const segments = splitSegments(payload, preset.segments).map(part => base64Encode(part, alphabet));
    const tamper = level !== 'fast' || options.tamperCheck === true;
    const checks = options.tamperCheck === true || level === 'absolute'
        ? Math.max(1, preset.checks)
        : preset.checks;
    const hookGuard = level === 'high' || level === 'absolute';

    const names = {};
    const ids = [
        'unpack', 'concat', 'byte', 'char', 'sub', 'slen', 'floor', 'type', 'getmt', 'rawget',
        'tonum', 'nextf', 'error', 'pcall', 'rawequal', 'debug', 'pack', 'ENV', 'checkFn',
        'map', 'b64', 'xor', 'inflate', 'adler', 'sum2', 'segs', 'progLen', 'sum1', 'sum3',
        'keys', 'decode', 'parse', 'raw', 'protos', 'root', 'out', 'run', 'cl', 'P', 'U', 'code',
        'K', 'R', 'np', 'vn', 'V', 'top', 'pc', 'i'
    ];
    for (const id of ids) names[id] = nextName();

    const handlers = VM_OPS.map(name => ({
        name,
        number: opcodeNumbers[name],
        body: HANDLERS[name](names)
    }));

    const deadCount = preset.dead + (options.expandedTransforms === true ? 2 : 0);
    const dead = deadCount > 0 ? buildDeadFunctions(nextName, rng, deadCount) : '';

    const runtime = buildRuntime({
        names,
        alphabet,
        segments,
        compressedLength: compressed.length,
        checksum1: adler32(compressed),
        checksum2: weightedSum(compressed),
        layerKeys,
        tamper,
        checks,
        hookGuard,
        handlers,
        rng,
        opaque: makeOpaque(rng, Math.max(checks, 1))
    });

    return buildHeader() + dead + runtime;
}
