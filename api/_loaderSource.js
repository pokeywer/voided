import { randomBytes } from 'node:crypto';
import { deriveBootstrapSeed } from './_loaderToken.js';
import { xorKeystream } from './_loaderShield.js';
import { buildRemovedVaultGui } from './_removedVaultGui.js';
import { obfuscateLoaderSource } from './_loaderObfuscator.js';

export function luaString(str) {
    const escaped = String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\0/g, '\\000');
    return `"${escaped}"`;
}

// Return a compact transport copy; this is cosmetic and does not replace the
// server-side ticket and key checks that protect delivery.
export function compactGeneratedLoader(source) {
    let output = '';
    let index = 0;
    let needsSpace = false;

    const append = value => {
        if (needsSpace && output && !output.endsWith(' ')) output += ' ';
        output += value;
        needsSpace = false;
    };
    const longBracket = start => {
        if (source[start] !== '[') return null;
        let cursor = start + 1;
        while (source[cursor] === '=') cursor++;
        if (source[cursor] !== '[') return null;
        return { contentStart: cursor + 1, close: `]${'='.repeat(cursor - start - 1)}]` };
    };

    while (index < source.length) {
        const char = source[index];
        if (/\s/.test(char)) {
            needsSpace = true;
            index++;
            continue;
        }

        if (char === '-' && source[index + 1] === '-') {
            needsSpace = true;
            const bracket = longBracket(index + 2);
            if (bracket) {
                const closeIndex = source.indexOf(bracket.close, bracket.contentStart);
                index = closeIndex < 0 ? source.length : closeIndex + bracket.close.length;
            } else {
                while (index < source.length && source[index] !== '\n') index++;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            const quote = char;
            let end = index + 1;
            while (end < source.length) {
                if (source[end] === '\\') { end += 2; continue; }
                if (source[end++] === quote) break;
            }
            append(source.slice(index, end));
            index = end;
            continue;
        }

        const bracket = longBracket(index);
        if (bracket) {
            const closeIndex = source.indexOf(bracket.close, bracket.contentStart);
            const end = closeIndex < 0 ? source.length : closeIndex + bracket.close.length;
            append(source.slice(index, end));
            index = end;
            continue;
        }

        append(char);
        index++;
    }

    return output.trim();
}

// Shared with the obfuscation banner so every VoidedX surface uses the same
// block lettering.
const LOADER_BANNER_FONT = {
    V: ['##   ##', '##   ##', '##   ##', ' ## ## ', '  ###  '],
    O: [' ##### ', '##   ##', '##   ##', '##   ##', ' ##### '],
    I: ['######', '  ##  ', '  ##  ', '  ##  ', '######'],
    D: ['##### ', '##  ##', '##  ##', '##  ##', '##### '],
    E: ['######', '##    ', '####  ', '##    ', '######'],
    X: ['##   ##', ' ## ## ', '  ###  ', ' ## ## ', '##   ##']
};

function buildLoaderBanner() {
    const rows = ['', '', '', '', ''];
    for (const letter of 'VOIDEDX') {
        const glyph = LOADER_BANNER_FONT[letter] || ['      ', '      ', '      ', '      ', '      '];
        for (let row = 0; row < 5; row += 1) rows[row] += glyph[row] + ' ';
    }
    return [
        '--[[',
        '   ' + rows[0],
        '   ' + rows[1],
        '   ' + rows[2],
        '   ' + rows[3],
        '   ' + rows[4],
        '',
        '   VoidedX Loader   //   voidedx.vercel.app',
        '   protected delivery build   |   do not resell',
        ']]'
    ].join('\n');
}

function createLoaderNames() {
    const used = new Set();
    return () => {
        let name;
        do {
            name = `_0x${randomBytes(4).toString('hex')}`;
        } while (used.has(name));
        used.add(name);
        return name;
    };
}

// The returned bootstrap carries only ciphertext: the inner loader is sealed
// with the token-derived seed, and the gate URL (which embeds the live token)
// is sealed with a per-build key. It opens with a VoidedX banner and refuses to
// decrypt when the runtime has been instrumented, so a dumped body cannot be
// read or replayed with a hooked loadstring/HttpGet. The gate response releases
// the seed, so a captured body alone still cannot be decrypted offline.
export function packGeneratedLoader(source, { id, key = '', origin, token }) {
    const innerBanner = '-- VoidedX Loader [https://voidedx.vercel.app]';
    const seed = deriveBootstrapSeed(token);
    const sealed = obfuscateLoaderSource(source);
    const cipher = xorKeystream(`${innerBanner}\n${sealed}`, seed).toString('base64url');
    const gateUrl = new URL('/api/raw', origin);
    gateUrl.searchParams.set('id', id);
    gateUrl.searchParams.set('token', token);
    gateUrl.searchParams.set('format', 'token-check');
    if (key) gateUrl.searchParams.set('key', key);

    // The URL never appears as a literal. It is XORed with a per-build key and
    // stored as base64url, then rebuilt next to the gate request.
    const urlKey = randomBytes(4).readUInt32BE(0) || 1;
    const urlCipher = xorKeystream(gateUrl.href, urlKey).toString('base64url');
    const chunkName = randomBytes(6).toString('hex');

    const name = createLoaderNames();
    const n = {
        data: name(), map: name(), alpha: name(), index: name(), b64: name(), xor: name(),
        cap: name(), guard: name(), deny: name(), url: name(), ok: name(), res: name(),
        seed: name(), loader: name(), chunk: name(), err: name(),
        lstr: name(), ld: name(), gv: name(), gf: name(), dmp: name(), envs: name(), adde: name(),
        env: name(), sh: name(), gh: name(), wd: name(), off: name(), ticks: name(),
        code: name(), arg: name(), pos: name()
    };
    const cap = i => `${n.cap}[${i}]`;

    return `${buildLoaderBanner()}
local ${n.data}="${cipher}"
local ${n.map}={}
do local ${n.alpha}="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
for ${n.index}=1,#${n.alpha} do ${n.map}[string.sub(${n.alpha},${n.index},${n.index})]=${n.index}-1 end end
local function ${n.b64}(v)
v=string.gsub(v,"%-","+")
v=string.gsub(v,"_","/")
local r=#v%4
if r==2 then v=v.."==" elseif r==3 then v=v.."=" end
local o={}
local i=1
while i<=#v do
local c1=${n.map}[string.sub(v,i,i)] or 0
local c2=${n.map}[string.sub(v,i+1,i+1)] or 0
local c3=${n.map}[string.sub(v,i+2,i+2)]
local c4=${n.map}[string.sub(v,i+3,i+3)]
local x=c1*262144+c2*4096+(c3 or 0)*64+(c4 or 0)
o[#o+1]=string.char(math.floor(x/65536)%256)
if c3 then o[#o+1]=string.char(math.floor(x/256)%256) end
if c4 then o[#o+1]=string.char(x%256) end
i=i+4
end
return table.concat(o)
end
local function ${n.xor}(v,s)
local o={}
local i=1
while i<=#v do
local j=(i-1)%4
if j==0 then
s=bit32.bxor(s,bit32.lshift(s,13))
s=bit32.bxor(s,bit32.rshift(s,17))
s=bit32.bxor(s,bit32.lshift(s,5))
end
o[#o+1]=string.char(bit32.bxor(string.byte(v,i),bit32.rshift(s,24-j*8)%256))
i=i+1
end
return table.concat(o)
end
local ${n.cap}={}
do
${cap(1)}=string.byte ${cap(2)}=string.char ${cap(3)}=string.sub ${cap(4)}=string.gsub ${cap(5)}=string.match
${cap(6)}=table.concat ${cap(7)}=pcall ${cap(8)}=error ${cap(9)}=type ${cap(10)}=math.floor
${cap(11)}=loadstring or load
${cap(12)}=game.HttpGet
${cap(13)}=game.HttpGet==game.HttpGet
${cap(14)}=(loadstring or load)==(loadstring or load)
${cap(15)}=type(getgenv)=="function" and getgenv or nil
${cap(16)}=type(getfenv)=="function" and getfenv or nil
${cap(17)}=type(setfenv)=="function" and setfenv or nil
${cap(18)}=type(debug)=="table" and debug.gethook or nil
${cap(19)}=type(bit32)=="table" and bit32 or nil
${cap(20)}=type(tostring)=="function" and tostring or nil
${cap(21)}=type(tonumber)=="function" and tonumber or nil
end
local ${n.lstr}=loadstring
local ${n.ld}=load
local ${n.gv}=type(getgenv)=="function" and getgenv or nil
local ${n.gf}=type(getfenv)=="function" and getfenv or nil
local ${n.dmp}=type(string.dump)=="function" and string.dump or nil
local function ${n.guard}()
if ${cap(14)} and (loadstring or load)~=${cap(11)} then return false end
if ${cap(13)} and game.HttpGet~=${cap(12)} then return false end
if string.byte~=${cap(1)} or string.char~=${cap(2)} or string.sub~=${cap(3)} or string.gsub~=${cap(4)} or string.match~=${cap(5)} then return false end
if table.concat~=${cap(6)} or pcall~=${cap(7)} or error~=${cap(8)} or type~=${cap(9)} or math.floor~=${cap(10)} then return false end
if ${cap(15)} and (type(getgenv)~="function" or getgenv~=${cap(15)}) then return false end
if ${cap(16)} and (type(getfenv)~="function" or getfenv~=${cap(16)}) then return false end
if ${cap(17)} and (type(setfenv)~="function" or setfenv~=${cap(17)}) then return false end
if ${cap(19)} and (bit32.bxor~=${cap(19)}.bxor or bit32.lshift~=${cap(19)}.lshift or bit32.rshift~=${cap(19)}.rshift) then return false end
if ${cap(18)} then local ok,h=${cap(7)}(${cap(18)}) if ok and h~=nil then return false end end
if ${n.dmp} and string.dump~=${n.dmp} then return false end
local ${n.envs}={}
local function ${n.adde}(e)
if type(e)~="table" then return end
for i=1,#${n.envs} do if ${n.envs}[i]==e then return end end
${n.envs}[#${n.envs}+1]=e
end
if ${n.gf} then local ok,e=${cap(7)}(${n.gf},0) if ok then ${n.adde}(e) end end
if ${n.gv} then local ok,e=${cap(7)}(${n.gv}) if ok then ${n.adde}(e) end end
for i=1,#${n.envs} do
local ls=${n.envs}[i].loadstring
local ld=${n.envs}[i].load
if ${n.lstr} and type(ls)=="function" and ls~=${n.lstr} then return false end
if ${n.ld} and type(ld)=="function" and ld~=${n.ld} then return false end
end
if ${n.dmp} then
if ${n.lstr} and ${cap(7)}(${n.dmp},${n.lstr}) and ${n.ld} and type(${n.ld})=="function" and not ${cap(7)}(${n.dmp},${n.ld}) then return false end
if ${n.ld} and ${cap(7)}(${n.dmp},${n.ld}) and ${n.lstr} and type(${n.lstr})=="function" and not ${cap(7)}(${n.dmp},${n.lstr}) then return false end
end
return true
end
local ${n.deny}="Voided: Doing this is not allowed."
if not ${n.guard}() then return ${cap(8)}(${n.deny},0) end
local ${n.url}=${n.xor}(${n.b64}("${urlCipher}"),0x${urlKey.toString(16)})
local ${n.ok},${n.res}=${cap(7)}(function() return game:HttpGet(${n.url}) end)
if not ${n.ok} or type(${n.res})~="string" then return ${cap(8)}("[VoidedX] Error: Loader expired. Get a new loader from the website and try again.",0) end
local ${n.seed}=${cap(5)}(${n.res},"^vx1|(%x+)|%x+$")
if not ${n.seed} then return ${cap(8)}("[VoidedX] Error: Loader expired. Get a new loader from the website and try again.",0) end
if not ${n.guard}() then return ${cap(8)}(${n.deny},0) end
local ${n.loader}=${cap(11)}
if ${n.ld} and ${n.ld}~=${n.loader} then local ok,f=${cap(7)}(${n.ld},"return 1") if ok and type(f)=="function" then ${n.loader}=${n.ld} end end
if type(${n.loader})~="function" then return ${cap(8)}("[VoidedX] This executor does not support loadstring.",0) end
local ${n.code}=${n.xor}(${n.b64}(${n.data}),${cap(21)}(${n.seed},16))
local ${n.arg}=${n.code}
local okProbe,probeFn=${cap(7)}(${n.loader},function() return nil end)
if okProbe and type(probeFn)=="function" then
local ${n.pos}=0
${n.arg}=function()
if ${n.pos}>=#${n.code} then return nil end
local part=${cap(3)}(${n.code},${n.pos}+1,${n.pos}+4096)
${n.pos}=${n.pos}+4096
return part
end
end
local ${n.chunk},${n.err}=${n.loader}(${n.arg},"=${chunkName}")
if not ${n.chunk} then return ${cap(8)}(${cap(20)}(${n.err}),0) end
local ${n.sh}=type(debug)=="table" and debug.sethook or nil
local ${n.gh}=type(debug)=="table" and debug.gethook or nil
local ${n.env}=nil
if ${n.gv} then local ok,e=${cap(7)}(${n.gv}) if ok and type(e)=="table" then ${n.env}=e end end
local ${n.wd},${n.off}
if ${n.sh} and ${n.gh} then
local ${n.ticks}=0
${n.off}=function()
local ok,h=${cap(7)}(${n.gh})
if ok and h==${n.wd} then ${cap(7)}(${n.sh}) end
if ${n.env} then ${cap(7)}(function() if ${n.env}._vxwd==${n.wd} then ${n.env}._vxwd=nil end end) end
end
${n.wd}=function()
${n.ticks}=${n.ticks}+1
if string.byte~=${cap(1)} or string.char~=${cap(2)} or string.sub~=${cap(3)} or string.gsub~=${cap(4)} or string.match~=${cap(5)} or table.concat~=${cap(6)} or pcall~=${cap(7)} or type~=${cap(9)} or math.floor~=${cap(10)} then ${cap(7)}(${n.sh}) return ${cap(8)}(${n.deny},0) end
local ok,h=${cap(7)}(${n.gh})
if ok and h~=nil and h~=${n.wd} then ${cap(7)}(${n.sh}) return ${cap(8)}(${n.deny},0) end
if ${n.ticks}>=64 then ${n.off}() end
end
if ${cap(7)}(${n.sh},${n.wd},"",250000) then
local ok,h=${cap(7)}(${n.gh})
if ok and h==${n.wd} then
if ${n.env} then ${cap(7)}(function() ${n.env}._vxwd=${n.wd} end) end
if type(task)=="table" and type(task.delay)=="function" then ${cap(7)}(task.delay,10,${n.off}) end
else ${cap(7)}(${n.sh}) end
end
end
return ${n.chunk}()`;
}

export function buildPayloadRuntime(origin, options = {}) {
    const instant = options.instant === true;
    // Instant loaders carry no progress renderer at all, so the only console
    // output they can produce is the VoidedX credit line.
    const progressPrinter = instant
        ? 'local function vxProgress() end'
        : `local vxLastProgressBlocks, vxLastProgressStage
local function vxProgress(percent, stage)
    percent = math.max(0, math.min(100, math.floor(percent)))
    local width = 14
    local filled = math.floor(width * percent / 100)
    if filled == vxLastProgressBlocks and stage == vxLastProgressStage then return end
    vxLastProgressBlocks = filled
    vxLastProgressStage = stage
    local line = vxFormat(
        "[VoidedX] [%s%s] %3d%%  %s",
        vxRep("=", filled),
        vxRep("-", width - filled),
        percent,
        stage
    )
    vxPcall(vxPrint, line)
end`;
    const payloadBase = luaString(`${origin}/api/payload?session=`);
    const integrityBase = luaString(`${origin}/api/integrity?session=`);
    return `
local vxPayloadBase = ${payloadBase}
local vxIntegrityBase = ${integrityBase}
local vxBit = bit32
if type(vxBit) ~= "table" then
    return error("[VoidedX] Your executor is missing the Lua runtime this loader needs.", 0)
end
local vxBxor, vxLshift, vxRshift, vxBand = vxBit.bxor, vxBit.lshift, vxBit.rshift, vxBit.band
-- Some executors build game.HttpGet on each access; only trust identity when it is stable.
local vxHttpGet = game.HttpGet
local vxHttpGetStable = game.HttpGet == game.HttpGet
local vxLoad = loadstring or load
-- Prefer the other native compile entry when both exist: a logger that only
-- wraps loadstring never sees the armored payload, and vice versa.
local vxLoadAlt = (loadstring and load and loadstring ~= load) and ((vxLoad == loadstring) and load or loadstring) or nil
if type(vxLoadAlt) == "function" then
    local vxAltOk, vxAltProbe = pcall(vxLoadAlt, "return 1")
    if vxAltOk and type(vxAltProbe) == "function" then vxLoad = vxLoadAlt end
end
local vxLoadStable = (loadstring or load) == vxLoad
local vxJsonDecode = HttpService.JSONDecode
local vxJsonStable = HttpService.JSONDecode == vxJsonDecode
local vxChar = string.char
local vxByte = string.byte
local vxSub = string.sub
local vxFormat = string.format
local vxRep = string.rep
local vxConcat = table.concat
local vxGsub = string.gsub
local vxMatch = string.match
local vxPcall = pcall
local vxInfo = type(debug) == "table" and debug.info or nil
local vxInfoStable = vxInfo ~= nil and debug.info == vxInfo
local vxRawEqual = rawequal
-- Snapshot the runtime pieces a hook would have to replace. Identity is only
-- trusted for accessors that returned the same function twice at startup, since
-- some executors build a fresh closure on every read.
local vxPrint = print
local vxTostring = tostring
local vxTonumber = tonumber
local vxTypeOf = type
local vxError = error
local vxNext = next
local vxIpairs = ipairs
local vxSetmetatable = setmetatable
local vxRawset = rawset
local vxFloor = math.floor
local vxGetgenv = type(getgenv) == "function" and getgenv or nil
local vxShared = type(shared) == "table" and shared or nil
local vxGetService = game.GetService
local vxServiceStable = game.GetService == game.GetService
local vxUrlEncode = HttpService.UrlEncode
local vxUrlEncodeStable = HttpService.UrlEncode == HttpService.UrlEncode
local vxTaskWait = type(task) == "table" and task.wait or nil
local vxTaskSpawn = type(task) == "table" and task.spawn or nil

vxPcall(vxPrint, "[VoidedX] VoidedX Protection - protect your scripts at https://voidedx.vercel.app")

local vxInstant = ${instant ? 'true' : 'false'}

local vxB64Map = {}
do
    local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for index = 1, #alphabet do vxB64Map[vxSub(alphabet, index, index)] = index - 1 end
end

local function vxNextState(state)
    state = vxBxor(state, vxLshift(state, 13))
    state = vxBxor(state, vxRshift(state, 17))
    return vxBxor(state, vxLshift(state, 5))
end

local function vxBase64Decode(value)
    value = vxGsub(value, "%-", "+")
    value = vxGsub(value, "_", "/")
    local remainder = #value % 4
    if remainder == 2 then value = value .. "=="
    elseif remainder == 3 then value = value .. "=" end
    local out = {}
    local block = {}
    local index = 1
    while index <= #value do
        local c1 = vxB64Map[vxSub(value, index, index)] or 0
        local c2 = vxB64Map[vxSub(value, index + 1, index + 1)] or 0
        local c3 = vxB64Map[vxSub(value, index + 2, index + 2)]
        local c4 = vxB64Map[vxSub(value, index + 3, index + 3)]
        local packed = c1 * 262144 + c2 * 4096 + (c3 or 0) * 64 + (c4 or 0)
        block[#block + 1] = vxChar(math.floor(packed / 65536) % 256)
        if c3 then block[#block + 1] = vxChar(math.floor(packed / 256) % 256) end
        if c4 then block[#block + 1] = vxChar(packed % 256) end
        if #block >= 8192 then
            out[#out + 1] = vxConcat(block)
            block = {}
        end
        index = index + 4
    end
    if #block > 0 then out[#out + 1] = vxConcat(block) end
    return vxConcat(out)
end

local function vxXor(value, state)
    local out = {}
    local block = {}
    for index = 1, #value do
        local slot = (index - 1) % 4
        if slot == 0 then state = vxNextState(state) end
        block[#block + 1] = vxChar(vxBxor(vxByte(value, index), vxRshift(state, 24 - slot * 8) % 256))
        if #block >= 8192 then
            out[#out + 1] = vxConcat(block)
            block = {}
        end
    end
    if #block > 0 then out[#out + 1] = vxConcat(block) end
    return vxConcat(out)
end

local vxCrcTable
local function vxCrc32(value)
    if not vxCrcTable then
        vxCrcTable = {}
        for index = 0, 255 do
            local current = index
            for _ = 1, 8 do
                if current % 2 == 1 then current = vxBxor(vxRshift(current, 1), 0xEDB88320)
                else current = vxRshift(current, 1) end
            end
            vxCrcTable[index] = current
        end
    end
    local crc = 0xFFFFFFFF
    for index = 1, #value do
        local slot = vxBxor(vxBand(crc, 0xFF), vxByte(value, index))
        crc = vxBxor(vxCrcTable[slot], vxRshift(crc, 8))
    end
    return vxFormat("%08x", vxBxor(crc, 0xFFFFFFFF))
end

local function vxCollectFlags()
    local flags = {}
    local function add(name)
        for index = 1, #flags do
            if flags[index] == name then return end
        end
        flags[#flags + 1] = name
    end
    if vxHttpGetStable and game.HttpGet ~= vxHttpGet then add("http_swapped") end
    if vxLoadStable and (loadstring or load) ~= vxLoad then add("load_swapped") end
    if vxJsonStable and HttpService.JSONDecode ~= vxJsonDecode then add("json_swapped") end
    if string.char ~= vxChar or string.byte ~= vxByte or string.sub ~= vxSub then add("string_swapped") end
    if table.concat ~= vxConcat then add("table_swapped") end
    if pcall ~= vxPcall then add("pcall_swapped") end
    if rawequal ~= vxRawEqual then add("rawequal_swapped") end
    if vxInfoStable and (type(debug) ~= "table" or debug.info ~= vxInfo) then add("debug_swapped") end
    if print ~= vxPrint then add("print_swapped") end
    if tostring ~= vxTostring or tonumber ~= vxTonumber or type ~= vxTypeOf
        or next ~= vxNext or ipairs ~= vxIpairs
        or setmetatable ~= vxSetmetatable or rawset ~= vxRawset
        or math.floor ~= vxFloor then
        add("builtin_swapped")
    end
    if string.format ~= vxFormat or string.rep ~= vxRep or string.gsub ~= vxGsub or string.match ~= vxMatch then
        add("builtin_swapped")
    end
    if vxGetgenv and (type(getgenv) ~= "function" or getgenv ~= vxGetgenv) then add("env_swapped") end
    if vxServiceStable and game.GetService ~= vxGetService then add("service_swapped") end
    if vxUrlEncodeStable and HttpService.UrlEncode ~= vxUrlEncode then add("urlencode_swapped") end
    if (vxTaskWait and task.wait ~= vxTaskWait) or (vxTaskSpawn and task.spawn ~= vxTaskSpawn) then
        add("task_swapped")
    end
    return flags
end

local function vxReport(report, trace, flags)
    if type(report) ~= "string" or report == "" or #flags == 0 then return false end
    local safe = {}
    for index = 1, #flags do
        if vxMatch(flags[index], "^[a-z_]+$") then safe[#safe + 1] = flags[index] end
    end
    if #safe == 0 then return false end
    local url = vxIntegrityBase .. report
        .. "&trace=" .. vxGsub(trace or "", "[^%x]", "")
        .. "&flags=" .. vxConcat(safe, ",")
    local ok, response = vxPcall(function() return vxHttpGet(game, url) end)
    if not ok or type(response) ~= "string" then return false end
    local decodedOk, decoded = vxPcall(vxJsonDecode, HttpService, response)
    return decodedOk and type(decoded) == "table" and decoded.block == true
end

${progressPrinter}

local function vxUnshield(result, shield)
    if type(result.parts) ~= "table" or type(shield.order) ~= "table" then
        return nil, "payload_shape_invalid"
    end
    local count = #shield.order
    if #result.parts ~= count or count < 1 or count > 64 then
        return nil, "payload_shape_invalid"
    end
    local chunks = {}
    local seen = {}
    for index = 1, count do
        local target = shield.order[index]
        if type(target) ~= "number" or target < 1 or target > count or seen[target] then
            return nil, "order_invalid"
        end
        seen[target] = true
        if type(result.parts[index]) ~= "string" then return nil, "payload_shape_invalid" end
        chunks[target] = vxBase64Decode(result.parts[index])
    end
    local seed = tonumber(shield.seed, 16)
    if not seed then return nil, "payload_shape_invalid" end
    local code = vxXor(vxConcat(chunks), seed)
    local prefix = "--[[vx:" .. shield.trace .. "]]"
    if vxSub(code, 1, #prefix) ~= prefix then return nil, "watermark_missing" end
    if vxCrc32(code) ~= string.lower(tostring(result.crc or "")) then
        return nil, "payload_crc_mismatch"
    end
    return code
end

local function vxRunPayload(token, userId, shield, report)
    if type(token) ~= "string" or token == "" then
        return error("[VoidedX] The server did not issue a delivery ticket.", 0)
    end
    if type(shield) ~= "table"
        or type(shield.seed) ~= "string"
        or type(shield.order) ~= "table"
        or type(shield.trace) ~= "string" then
        return error("[VoidedX] The server did not issue a protected payload. Get a new loader from the website.", 0)
    end

    -- Honeypots. Nothing in this loader calls these functions. They are published
    -- under getgenv().VoidedX so anyone who finds the loaded chunk and tries to
    -- poke at its "unlock" or "dump" helpers reports themselves to /api/integrity
    -- before the payload is requested. Reading an unknown field trips the guard
    -- too, which catches tools that enumerate the table.
    local function vxHoneypotHit()
        vxReport(report, shield.trace, { "honeypot_triggered" })
        return vxError("[VoidedX] This loader was modified. Get a new loader from the website.", 0)
    end

    local function vxDecoyUnlock()
        return vxHoneypotHit()
    end

    local function vxDecoyDump()
        return vxHoneypotHit()
    end

    if vxGetgenv then
        local envOk, env = vxPcall(vxGetgenv)
        if envOk and vxTypeOf(env) == "table" then
            local decoy = {
                unlock = vxDecoyUnlock,
                bypass = vxDecoyUnlock,
                signature = vxDecoyDump,
                extract = vxDecoyDump,
                payload = vxDecoyDump,
                key = vxDecoyUnlock,
                token = vxDecoyDump,
                session = vxDecoyDump
            }
            local armed = vxPcall(function()
                vxSetmetatable(decoy, {
                    __index = function()
                        return vxHoneypotHit()
                    end,
                    __newindex = function(self, name, value)
                        vxRawset(self, name, value)
                        return vxHoneypotHit()
                    end
                })
            end)
            if armed then
                vxPcall(function() env.VoidedX = decoy end)
                if vxShared then vxPcall(function() vxShared.VoidedX = decoy end) end
            end
        end
    end

    local flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    local payloadUrl = vxPayloadBase .. HttpService:UrlEncode(token)
    if userId ~= nil then payloadUrl = payloadUrl .. "&userId=" .. HttpService:UrlEncode(tostring(userId)) end

    local requestOk, response
    local requestDone = false
    local progress = 2
    vxProgress(progress, "Connecting to server")

    local asyncStarted = false
    if not vxInstant and type(task) == "table" and type(task.spawn) == "function" and type(task.wait) == "function" then
        asyncStarted = vxPcall(function()
            task.spawn(function()
                requestOk, response = vxPcall(function() return vxHttpGet(game, payloadUrl) end)
                requestDone = true
            end)
        end)
    end

    if asyncStarted then
        while not requestDone do
            progress = math.min(progress + 6, 85)
            vxProgress(progress, "Downloading payload")
            task.wait(0.2)
        end
    else
        vxProgress(40, "Downloading payload")
        requestOk, response = vxPcall(function() return vxHttpGet(game, payloadUrl) end)
    end

    if not requestOk then
        vxProgress(progress, "Download failed")
        return error("[VoidedX] Could not download the script: " .. tostring(response), 0)
    end

    flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    vxProgress(90, "Verifying payload")
    local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
    if not decodeOk or type(result) ~= "table" then
        vxProgress(90, "Server error")
        return error("[VoidedX] The payload server returned a bad response.", 0)
    end
    if not result.ok then
        vxProgress(90, "Access denied")
        return error("[VoidedX] " .. tostring(result.message or "The script could not be delivered."), 0)
    end

    local executionCode
    if result.version == 4 then
        if type(result.trace) ~= "string" or result.trace ~= shield.trace then
            vxReport(report, shield.trace, { "payload_trace_mismatch" })
            return error("[VoidedX] The payload did not match this delivery session. Run the loader again.", 0)
        end
        local reason
        executionCode, reason = vxUnshield(result, shield)
        if not executionCode then
            vxReport(report, shield.trace, { reason })
            return error("[VoidedX] The payload failed its integrity check. Run the loader again.", 0)
        end
        vxProgress(95, "Integrity verified")
    else
        if type(result.code) ~= "string" then
            vxProgress(90, "Invalid payload")
            return error("[VoidedX] The payload server returned no script.", 0)
        end
        executionCode = result.code
    end

    flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    vxProgress(97, "Compiling")
    local compileArg = executionCode
    local readerOk, readerProbe = vxPcall(vxLoad, function() return nil end)
    if readerOk and vxTypeOf(readerProbe) == "function" then
        local readPos = 0
        compileArg = function()
            if readPos >= #executionCode then return nil end
            local part = vxSub(executionCode, readPos + 1, readPos + 4096)
            readPos = readPos + 4096
            return part
        end
    end
    local scriptChunk, compileError = vxLoad(compileArg)
    if not scriptChunk then
        vxProgress(97, "Compilation failed")
        return error("[VoidedX] " .. tostring(compileError), 0)
    end
    vxProgress(100, "Ready")
    if type(task) == "table" and type(task.synchronize) == "function" then
        vxPcall(task.synchronize)
    end
    return scriptChunk()
end
`.trim();
}
export function buildKeyLoader(id, key, origin, loaderToken, options = {}) {
    const verifyBase = `${origin}/api/verify`;
    return packGeneratedLoader(compactGeneratedLoader(`
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options)}

local ok, response = vxPcall(function()
    return vxHttpGet(
        game,
        "${verifyBase}?id=${encodeURIComponent(id)}" ..
        "&key=" .. HttpService:UrlEncode(${luaString(key)}) ..
        "&userId=" .. tostring(player.UserId) ..
        "&username=" .. HttpService:UrlEncode(player.Name)
    )
end)

if not ok then
    return error("[VoidedX] Could not reach the verification server. Try again.", 0)
end

local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
if not decodeOk or type(result) ~= "table" then
    return error("[VoidedX] Verification server returned a bad response.", 0)
end

if not result.ok then
    if result.code == "vault_removed" then
        ${buildRemovedVaultGui()}
        return
    end
    return error("[VoidedX] " .. tostring(result.message or "Access denied."), 0)
end

return vxRunPayload(result.token, player and player.UserId or nil, result.shield, result.report)
`), { id, key, origin, token: loaderToken });
}

export function buildTrackedScript(id, origin, loaderToken, key = '', options = {}) {
    const verifyUrl = `${origin}/api/verify?id=${encodeURIComponent(id)}`;
    return packGeneratedLoader(compactGeneratedLoader(`
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options)}
local verifyUrl = ${luaString(verifyUrl)}
if player then verifyUrl = verifyUrl .. "&userId=" .. HttpService:UrlEncode(tostring(player.UserId)) end

local requestOk, response = vxPcall(function()
    return vxHttpGet(game, verifyUrl)
end)
if not requestOk then
    error("[VoidedX] Could not reach the loader server: " .. tostring(response), 0)
end
local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
if not decodeOk or type(result) ~= "table" then
    error("[VoidedX] Verification server returned a bad response.", 0)
end
if not result.ok then
    if result.code == "vault_removed" then
        ${buildRemovedVaultGui()}
        return
    end
    error("[VoidedX] " .. tostring(result.message or "Could not load the script."), 0)
end
return vxRunPayload(result.token, player and player.UserId or nil, result.shield, result.report)
`), { id, key, origin, token: loaderToken });
}
