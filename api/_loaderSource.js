import { deriveBootstrapSeed } from './_loaderToken.js';
import { xorKeystream } from './_loaderShield.js';
import { buildRemovedVaultGui } from './_removedVaultGui.js';

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

// The returned bootstrap carries only ciphertext. The gate response releases the
// token-derived seed, so a captured body alone cannot be decrypted offline.
export function packGeneratedLoader(source, { id, key = '', origin, token }) {
    const seed = deriveBootstrapSeed(token);
    const cipher = xorKeystream(source, seed).toString('base64url');
    const gateUrl = new URL('/api/raw', origin);
    gateUrl.searchParams.set('id', id);
    gateUrl.searchParams.set('token', token);
    gateUrl.searchParams.set('format', 'token-check');
    if (key) gateUrl.searchParams.set('key', key);

    return `local _b0="${cipher}"
local _b1=${luaString(gateUrl.href)}
local _bmap={}
do
local _ba="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
for _bi=1,#_ba do _bmap[string.sub(_ba,_bi,_bi)]=_bi-1 end
end
local function _bb(v)
v=string.gsub(v,"%-","+")
v=string.gsub(v,"_","/")
local _r=#v%4
if _r==2 then v=v.."==" elseif _r==3 then v=v.."=" end
local _o={}
local _i=1
while _i<=#v do
local _c1=_bmap[string.sub(v,_i,_i)] or 0
local _c2=_bmap[string.sub(v,_i+1,_i+1)] or 0
local _c3=_bmap[string.sub(v,_i+2,_i+2)]
local _c4=_bmap[string.sub(v,_i+3,_i+3)]
local _n=_c1*262144+_c2*4096+(_c3 or 0)*64+(_c4 or 0)
_o[#_o+1]=string.char(math.floor(_n/65536)%256)
if _c3 then _o[#_o+1]=string.char(math.floor(_n/256)%256) end
if _c4 then _o[#_o+1]=string.char(_n%256) end
_i=_i+4
end
return table.concat(_o)
end
local function _bx(v,s)
local _xor,_ls,_rs=bit32.bxor,bit32.lshift,bit32.rshift
local _o={}
for _i=1,#v do
local _j=(_i-1)%4
if _j==0 then
s=_xor(s,_ls(s,13))
s=_xor(s,_rs(s,17))
s=_xor(s,_ls(s,5))
end
_o[_i]=string.char(_xor(string.byte(v,_i),_rs(s,24-_j*8)%256))
end
return table.concat(_o)
end
local _bok,_bres=pcall(function() return game:HttpGet(_b1) end)
if not _bok or type(_bres)~="string" then return error("[VoidedX] Error: Loader expired. Get a new loader from the website and try again.",0) end
local _bseed=string.match(_bres,"^vx1|(%x+)|%x+$")
if not _bseed then return error("[VoidedX] Error: Loader expired. Get a new loader from the website and try again.",0) end
local _bc=loadstring or load
if type(_bc)~="function" then return error("[VoidedX] This executor does not support loadstring.",0) end
local _bf,_be=_bc(_bx(_bb(_b0),tonumber(_bseed,16)))
if not _bf then return error(tostring(_be),0) end
return _bf()`;
}

export function buildPayloadRuntime(origin) {
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
local vxLoadStable = (loadstring or load) == vxLoad
local vxJsonDecode = HttpService.JSONDecode
local vxJsonStable = HttpService.JSONDecode == vxJsonDecode
local vxChar = string.char
local vxByte = string.byte
local vxSub = string.sub
local vxFormat = string.format
local vxConcat = table.concat
local vxGsub = string.gsub
local vxMatch = string.match
local vxPcall = pcall
local vxInfo = type(debug) == "table" and debug.info or nil
local vxInfoStable = vxInfo ~= nil and debug.info == vxInfo
local vxRawEqual = rawequal

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

local vxLastProgressBlocks, vxLastProgressStage
local function vxProgress(percent, stage)
    percent = math.max(1, math.min(100, math.floor(percent)))
    local width = 10
    local filled = math.max(1, math.floor(width * percent / 100))
    if filled == vxLastProgressBlocks and stage == vxLastProgressStage then return end
    vxLastProgressBlocks = filled
    vxLastProgressStage = stage
    local line = string.format(
        "[VoidedX] Loading script %s%s %d%% - %s",
        string.rep("🟩", filled),
        string.rep("⬛", width - filled),
        percent,
        stage
    )
    vxPcall(print, line)
end

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

    local flags = vxCollectFlags()
    if #flags > 0 and vxReport(report, shield.trace, flags) then
        return error("[VoidedX] This session was blocked because the runtime environment was modified.", 0)
    end

    local payloadUrl = vxPayloadBase .. HttpService:UrlEncode(token)
    if userId ~= nil then payloadUrl = payloadUrl .. "&userId=" .. HttpService:UrlEncode(tostring(userId)) end

    local requestOk, response
    local requestDone = false
    local progress = 1
    vxProgress(progress, "Connecting to delivery server")

    local asyncStarted = false
    if type(task) == "table" and type(task.spawn) == "function" and type(task.wait) == "function" then
        asyncStarted = vxPcall(function()
            task.spawn(function()
                requestOk, response = vxPcall(function() return vxHttpGet(game, payloadUrl) end)
                requestDone = true
            end)
        end)
    end

    if asyncStarted then
        while not requestDone do
            progress = math.min(progress + 5, 85)
            vxProgress(progress, "Downloading script")
            task.wait(0.2)
        end
    else
        vxProgress(35, "Downloading script")
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

    vxProgress(90, "Checking downloaded script")
    local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
    if not decodeOk or type(result) ~= "table" then
        vxProgress(90, "Invalid server response")
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
        vxProgress(94, "Verified protected payload")
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

    vxProgress(96, "Compiling script")
    local scriptChunk, compileError = vxLoad(executionCode)
    if not scriptChunk then
        vxProgress(96, "Compilation failed")
        return error("[VoidedX] " .. tostring(compileError), 0)
    end
    vxProgress(100, "Starting")
    if type(task) == "table" and type(task.synchronize) == "function" then
        vxPcall(task.synchronize)
    end
    return scriptChunk()
end
`.trim();
}
export function buildKeyLoader(id, key, origin, loaderToken) {
    const verifyBase = `${origin}/api/verify`;
    return packGeneratedLoader(compactGeneratedLoader(`
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin)}

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

export function buildTrackedScript(id, origin, loaderToken, key = '') {
    const verifyUrl = `${origin}/api/verify?id=${encodeURIComponent(id)}`;
    return packGeneratedLoader(compactGeneratedLoader(`
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin)}
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
