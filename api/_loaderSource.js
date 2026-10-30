import { createHash, randomBytes } from 'node:crypto';
import { deriveBootstrapSeed } from './_loaderToken.js';
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

export const ROBLOX_ONLY_MESSAGE = '[VoidedX] This loader only works inside Roblox.';

// Every generated loader opens by proving it is running in a live Roblox
// client: `typeof` only exists in Luau, DataModel only exists in Roblox, and a
// real engine can hand back its own services and instances. A rehosted Lua, a
// different engine, or an analysis harness stubbed with plain tables is refused
// before the loader makes a single request.
export function robloxOnlyGuard() {
    return `if type(typeof)~="function" or typeof(game)~="Instance" or game.ClassName~="DataModel" then return error(${luaString(ROBLOX_ONLY_MESSAGE)},0) end`;
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
        '   VOIDEDX LOADER   //   voidedx.vercel.app',
        '   protected delivery build   |   do not resell',
        ']]'
    ].join('\n');
}

const LOADER_NAME_SYLLABLES = [
    'ka', 'zu', 'mo', 're', 'ti', 'vo', 'ne', 'ra', 'sh', 'ul',
    'ix', 'om', 'ep', 'an', 'yi', 'qu', 'da', 'po', 'fi', 'xe'
];

// A fixed `_0x` prefix is itself a fingerprint, so the naming scheme is drawn
// per build: hex, syllable pairs, or random base36. The counter keeps every
// name unique and the leading underscore keeps them clear of globals.
function createLoaderNames() {
    const used = new Set();
    const draw = () => randomBytes(1)[0];
    const style = draw() % 3;
    let prefix;
    if (style === 0) {
        prefix = `_0x${randomBytes(3).toString('hex')}`;
    } else if (style === 1) {
        prefix = `_${LOADER_NAME_SYLLABLES[draw() % LOADER_NAME_SYLLABLES.length]}`
            + `${LOADER_NAME_SYLLABLES[draw() % LOADER_NAME_SYLLABLES.length]}`;
    } else {
        prefix = `_${randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/g, 'z')}`;
    }
    let counter = 0;
    return () => {
        let name;
        do {
            counter += 1;
            name = `${prefix}${counter.toString(36)}`;
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
// Fabricated loader tokens carry the same structure as issued ones (base64url
// JSON + base64url HMAC), so a captured request log cannot separate a decoy
// from a revoked credential. Their signature is random, so the gate answers
// 410 before it ever touches Firestore.
const FAKE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomTokenString(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += FAKE_TOKEN_ALPHABET[bytes[index] % FAKE_TOKEN_ALPHABET.length];
    }
    return out;
}

function fakeLoaderToken(keyMaterial) {
    const payload = {
        version: 1,
        vaultId: randomTokenString(20),
        keyHash: keyMaterial ? createHash('sha256').update(String(keyMaterial)).digest('hex') : '',
        vaultVersion: 0,
        expiresAt: Date.now() + 10_000,
        nonce: randomBytes(16).toString('base64url'),
        binding: randomBytes(16).toString('hex')
    };
    return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

const BOOT_B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Each codec is a different xorshift shape and byte schedule. The Lua side is
// emitted with the same constants, so every fetch can pick a different decoder
// without the two ever drifting apart.
const BOOT_CODECS = Object.freeze([
    { a: 13, b: 17, c: 5, shifts: [24, 16, 8, 0] },
    { a: 7, b: 9, c: 13, shifts: [24, 8] },
    { a: 5, b: 11, c: 29, shifts: [16] }
]);

function bootPick(list) {
    return list[randomBytes(1)[0] % list.length];
}

function bootShuffle(items) {
    const out = items.slice();
    for (let index = out.length - 1; index > 0; index -= 1) {
        const swapIndex = randomBytes(1)[0] % (index + 1);
        const value = out[index];
        out[index] = out[swapIndex];
        out[swapIndex] = value;
    }
    return out;
}

function bootCodec() {
    return bootPick(BOOT_CODECS);
}

function bootAlphabet() {
    return bootShuffle(BOOT_B64_STD.split('')).join('');
}

function bootNextState(state, codec) {
    let value = state >>> 0;
    value = (value ^ (value << codec.a)) >>> 0;
    value = (value ^ (value >>> codec.b)) >>> 0;
    value = (value ^ (value << codec.c)) >>> 0;
    return value >>> 0;
}

function bootXor(input, seed, codec) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
    const output = Buffer.allocUnsafe(buffer.length);
    const width = codec.shifts.length;
    let state = (Number(seed) >>> 0) || 0x9E3779B9;
    for (let index = 0; index < buffer.length; index += 1) {
        if (index % width === 0) state = bootNextState(state, codec);
        output[index] = buffer[index] ^ ((state >>> codec.shifts[index % width]) & 0xFF);
    }
    return output;
}

function encodeBootAlphabet(buffer, alphabet) {
    const encoded = buffer.toString('base64');
    let out = '';
    for (const char of encoded) {
        const index = BOOT_B64_STD.indexOf(char);
        out += index === -1 ? char : alphabet[index];
    }
    return out;
}

export function packGeneratedLoader(source, { id, key = '', origin, token }) {
    const innerBanner = '-- VoidedX Loader [https://voidedx.vercel.app]';
    const seed = deriveBootstrapSeed(token);
    const sealed = obfuscateLoaderSource(source);
    // The marker only surfaces after the gate releases the seed, so a body
    // decrypted with a stale or fabricated seed fails loudly instead of
    // handing the executor garbage to compile.
    const bootMark = `--[[vb:${randomBytes(6).toString('hex')}]]`;
    // Every fetch rotates the outer codec, the base64 alphabet, how many parts
    // the ciphertext is split into, and the per-part key schedule. Two copies of
    // the same vault therefore never share a body, and a captured body is only
    // useful for the 10-second token it was minted for.
    const codec = bootCodec();
    const alphabet = bootAlphabet();
    const partCount = 1 + (randomBytes(1)[0] % 3);
    const partStep = randomBytes(4).readUInt32BE(0) || 0x9E3779B9;
    const codeBytes = Buffer.from(`${bootMark}\n${innerBanner}\n${sealed}`, 'utf8');
    const partSize = Math.ceil(codeBytes.length / partCount) || 1;
    const dataParts = [];
    for (let part = 0; part < partCount; part += 1) {
        const slice = codeBytes.subarray(part * partSize, Math.min((part + 1) * partSize, codeBytes.length));
        const partKey = (seed + part * partStep) >>> 0;
        dataParts.push(encodeBootAlphabet(bootXor(slice, partKey, codec), alphabet));
    }
    const dataLiteral = dataParts.map(part => `"${part}"`).join(',');

    const buildGateUrl = ({ vaultId, token: gateToken, key: gateKey }) => {
        const url = new URL('/api/raw', origin);
        url.searchParams.set('id', vaultId);
        url.searchParams.set('token', gateToken);
        url.searchParams.set('format', 'token-check');
        if (key) url.searchParams.set('key', gateKey || key);
        url.searchParams.set('n', randomBytes(9).toString('hex'));
        return url.href;
    };

    // No URL appears as a literal. Each is XORed with its own 32-bit key and
    // stored with the build's alphabet, then rebuilt right before its request.
    const sealUrl = href => {
        const urlKey = randomBytes(4).readUInt32BE(0) || 1;
        return { cipher: encodeBootAlphabet(bootXor(href, urlKey, codec), alphabet), key: urlKey };
    };

    const decoyKey = randomBytes(32).toString('hex');
    const realUrl = sealUrl(buildGateUrl({ vaultId: id, token, key }));
    const decoyCount = 2 + (randomBytes(1)[0] % 3);
    const decoys = [];
    for (let index = 0; index < decoyCount; index += 1) {
        if (index === 0) {
            // Unknown vault + unknown key: a dead end that still looks like a load.
            // Keyless vaults keep an empty keyHash so the shape matches the real one.
            decoys.push(sealUrl(buildGateUrl({
                vaultId: randomTokenString(20),
                token: fakeLoaderToken(key ? decoyKey : ''),
                key: key ? decoyKey : ''
            })));
        } else {
            // Real vault with a forged token: reads like a retry of the gate.
            decoys.push(sealUrl(buildGateUrl({ vaultId: id, token: fakeLoaderToken(key), key })));
        }
    }
    // The real gate is shuffled into the decoys, so neither the table order nor
    // the fetch order says which URL answers with the seed.
    const gateList = bootShuffle([realUrl].concat(decoys));
    const gateTable = gateList
        .map(entry => `{"${entry.cipher}",0x${entry.key.toString(16)}}`)
        .join(',');
    const probeOrder = bootShuffle(gateList.map((entry, index) => index + 1)).join(',');
    const chunkName = randomBytes(6).toString('hex');

    const name = createLoaderNames();
    const n = {
        data: name(), map: name(), alpha: name(), index: name(), b64: name(), xor: name(),
        cap: name(), guard: name(), deny: name(), exp: name(), net: name(), fails: name(), mark: name(),
        url: name(), ok: name(), res: name(), sealed: name(), dec: name(),
        fire: name(), spawn: name(), item: name(), slot: name(),
        seed: name(), loader: name(), chunk: name(), err: name(),
        lstr: name(), ld: name(), gv: name(), gf: name(), dmp: name(), envs: name(), adde: name(),
        env: name(), sh: name(), gh: name(), wd: name(), off: name(), ticks: name(),
        code: name(), arg: name(), pos: name(), own: name(), probeOk: name(), probeFn: name(),
        shifts: name(), order: name(), probe: name(), seedNum: name(), buf: name(), keyv: name(),
        stop: name(), rbx: name(), envOk: name(), envSvc: name()
    };
    const cap = i => `${n.cap}[${i}]`;

    return `${buildLoaderBanner()}
local ${n.rbx}=function()
if type(typeof)~="function" or typeof(game)~="Instance" or game.ClassName~="DataModel" then return false end
local ${n.envOk},${n.envSvc}=pcall(function() return game:GetService("Players") end)
if not ${n.envOk} or typeof(${n.envSvc})~="Instance" or ${n.envSvc}.ClassName~="Players" then return false end
${n.envOk},${n.envSvc}=pcall(function() return game:GetService("Workspace") end)
if not ${n.envOk} or typeof(${n.envSvc})~="Instance" or ${n.envSvc}.ClassName~="Workspace" then return false end
${n.envOk},${n.envSvc}=pcall(function() return Instance.new("Folder") end)
if not ${n.envOk} or typeof(${n.envSvc})~="Instance" or ${n.envSvc}.ClassName~="Folder" then return false end
pcall(function() ${n.envSvc}:Destroy() end)
return true
end
if not ${n.rbx}() then return error(${luaString(ROBLOX_ONLY_MESSAGE)},0) end
local ${n.data}={${dataLiteral}}
local ${n.map}={}
do local ${n.alpha}="${alphabet}"
for ${n.index}=1,#${n.alpha} do ${n.map}[string.sub(${n.alpha},${n.index},${n.index})]=${n.index}-1 end end
local function ${n.b64}(v)
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
local ${n.shifts}={${codec.shifts.join(',')}}
local function ${n.xor}(v,s)
local o={}
local i=1
local w=#${n.shifts}
s=s%4294967296
if s==0 then s=2654435769 end
while i<=#v do
local j=(i-1)%w
if j==0 then
s=bit32.bxor(s,bit32.lshift(s,${codec.a}))
s=bit32.bxor(s,bit32.rshift(s,${codec.b}))
s=bit32.bxor(s,bit32.lshift(s,${codec.c}))
s=s%4294967296
end
o[#o+1]=string.char(bit32.bxor(string.byte(v,i),bit32.rshift(s,${n.shifts}[j+1])%256))
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
${cap(22)}=type(debug)=="table" and debug.sethook or nil
end
local ${n.lstr}=loadstring
local ${n.ld}=load
local ${n.gv}=type(getgenv)=="function" and getgenv or nil
local ${n.gf}=type(getfenv)=="function" and getfenv or nil
local ${n.dmp}=type(string.dump)=="function" and string.dump or nil
local function ${n.guard}(${n.own})
if ${cap(14)} and (loadstring or load)~=${cap(11)} then return false end
if ${cap(13)} and game.HttpGet~=${cap(12)} then return false end
if string.byte~=${cap(1)} or string.char~=${cap(2)} or string.sub~=${cap(3)} or string.gsub~=${cap(4)} or string.match~=${cap(5)} then return false end
if table.concat~=${cap(6)} or pcall~=${cap(7)} or error~=${cap(8)} or type~=${cap(9)} or math.floor~=${cap(10)} then return false end
if ${cap(15)} and (type(getgenv)~="function" or getgenv~=${cap(15)}) then return false end
if ${cap(16)} and (type(getfenv)~="function" or getfenv~=${cap(16)}) then return false end
if ${cap(17)} and (type(setfenv)~="function" or setfenv~=${cap(17)}) then return false end
if ${cap(19)} and (bit32.bxor~=${cap(19)}.bxor or bit32.lshift~=${cap(19)}.lshift or bit32.rshift~=${cap(19)}.rshift) then return false end
if ${cap(18)} then local ok,h=${cap(7)}(${cap(18)}) if ok and h~=nil and h~=${n.own} then return false end end
if ${cap(22)} and (type(debug)~="table" or debug.sethook~=${cap(22)}) then return false end
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
local ${n.exp}="[VoidedX] Error: Loader expired. Get a new loader from the website and try again."
local ${n.net}="[VoidedX] Could not reach the loader server. Your network or DNS blocked the request. Set DNS to 1.1.1.1 or turn off your VPN, then run the loader again."
local ${n.mark}="${bootMark}"
if not ${n.guard}() then return ${cap(8)}(${n.deny},0) end
local ${n.sealed}={${gateTable}}
local ${n.order}={${probeOrder}}
local ${n.dec}={}
for ${n.slot}=1,#${n.sealed} do ${n.dec}[${n.slot}]=${n.xor}(${n.b64}(${n.sealed}[${n.slot}][1]),${n.sealed}[${n.slot}][2]) end
local ${n.fire}=function(${n.item}) ${cap(7)}(function() return ${cap(12)}(game,${n.item}) end) end
local ${n.spawn}=${cap(9)}(task)=="table" and task.spawn or nil
local ${n.seed},${n.ok},${n.res},${n.stop},${n.fails}=nil,nil,nil,#${n.order},0
for ${n.probe}=1,#${n.order} do
${n.ok},${n.res}=${cap(7)}(function() return ${cap(12)}(game,${n.dec}[${n.order}[${n.probe}]]) end)
if ${n.ok} and type(${n.res})=="string" then
local hit=${cap(5)}(${n.res},"^vx1|(%x+)|%x+$")
if hit then ${n.seed}=hit end
elseif not ${n.ok} then ${n.fails}=${n.fails}+1 end
if ${n.seed} then ${n.stop}=${n.probe} break end
end
-- The unprobed candidates are still requested once each, so a request log
-- shows every table entry exactly one time and no URL stands out as the one
-- that answered with the seed.
if ${n.stop}<#${n.order} then
if ${n.spawn} then
for ${n.slot}=${n.stop}+1,#${n.order} do ${cap(7)}(${n.spawn},${n.fire},${n.dec}[${n.order}[${n.slot}]]) end
else
for ${n.slot}=${n.stop}+1,#${n.order} do ${n.fire}(${n.dec}[${n.order}[${n.slot}]]) end
end
end
if ${cap(13)} and game.HttpGet~=${cap(12)} then return ${cap(8)}(${n.deny},0) end
if not ${n.seed} then
if ${n.fails}>=#${n.order} then return ${cap(8)}(${n.net},0) end
return ${cap(8)}(${n.exp},0)
end
if not ${n.guard}() then return ${cap(8)}(${n.deny},0) end
local ${n.loader}=${cap(11)}
if ${n.ld} and ${n.ld}~=${n.loader} then local ok,f=${cap(7)}(${n.ld},"return 1") if ok and type(f)=="function" then ${n.loader}=${n.ld} end end
if type(${n.loader})~="function" then return ${cap(8)}("[VoidedX] This executor does not support loadstring.",0) end
local ${n.buf}={}
local ${n.seedNum}
for ${n.slot}=1,#${n.data} do
${n.seedNum}=(${cap(21)}(${n.seed},16)+(${n.slot}-1)*${partStep})%4294967296
${n.buf}[${n.slot}]=${n.xor}(${n.b64}(${n.data}[${n.slot}]),${n.seedNum})
end
local ${n.code}=${cap(6)}(${n.buf})
if ${cap(3)}(${n.code},1,#${n.mark})~=${n.mark} then return ${cap(8)}(${n.exp},0) end
local ${n.arg}=${n.code}
local ${n.probeOk},${n.probeFn}=${cap(7)}(${n.loader},function() return nil end)
if ${n.probeOk} and type(${n.probeFn})=="function" then
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
if string.byte~=${cap(1)} or string.char~=${cap(2)} or string.sub~=${cap(3)} or string.gsub~=${cap(4)} or string.match~=${cap(5)} or table.concat~=${cap(6)} or pcall~=${cap(7)} or type~=${cap(9)} or math.floor~=${cap(10)} or error~=${cap(8)} then ${cap(7)}(${n.sh}) return ${cap(8)}(${n.deny},0) end
if ${cap(22)} and debug.sethook~=${cap(22)} then ${cap(7)}(${n.sh}) return ${cap(8)}(${n.deny},0) end
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
if not ${n.guard}(${n.wd}) then ${cap(7)}(${n.sh}) return ${cap(8)}(${n.deny},0) end
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
local vxDump = string.dump
local vxDumpStable = vxDump ~= nil and string.dump == vxDump
local vxSetHook = type(debug) == "table" and debug.sethook or nil
local vxSetHookStable = vxSetHook ~= nil and debug.sethook == vxSetHook
local vxGetHook = type(debug) == "table" and debug.gethook or nil
local vxGetHookStable = vxGetHook ~= nil and debug.gethook == vxGetHook
local vxGetfenv = type(getfenv) == "function" and getfenv or nil
local vxGetfenvStable = vxGetfenv ~= nil and getfenv == vxGetfenv
local vxSetfenv = type(setfenv) == "function" and setfenv or nil
local vxSetfenvStable = vxSetfenv ~= nil and setfenv == vxSetfenv
local vxErrorStable = error == vxError
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

local function vxPlaceParam()
    local place = game and game.PlaceId
    if type(place) == "number" then return "&placeId=" .. vxTostring(place) end
    return ""
end

local function vxEncode(value)
    local text = vxTostring(value or "")
    local ok, encoded = vxPcall(vxUrlEncode, HttpService, text)
    if ok and type(encoded) == "string" then return encoded end
    return (vxGsub(text, "[^%w%-%._~]", function(char)
        return vxFormat("%%%02X", vxByte(char))
    end))
end

-- Everything the owner dashboard groups executions by travels on the verify
-- call. Executor APIs differ, so each probe is guarded and simply omitted when
-- the function is missing.
local function vxClientParams(player)
    local params = ""
    if player then
        params = params .. "&userId=" .. vxTostring(player.UserId)
        local nameOk, name = vxPcall(function() return player.Name end)
        if nameOk and type(name) == "string" and name ~= "" then
            params = params .. "&username=" .. vxEncode(vxSub(name, 1, 32))
        end
    end
    -- Executor identity: identifyexecutor first, then the aliases other executors expose.
    local executor = nil
    if type(identifyexecutor) == "function" then
        local ok, value = vxPcall(identifyexecutor)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if not executor and type(getexecutorname) == "function" then
        local ok, value = vxPcall(getexecutorname)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if not executor and type(syn) == "table" and type(syn.get_executor) == "function" then
        local ok, value = vxPcall(function() return syn.get_executor() end)
        if ok and type(value) == "string" and value ~= "" then executor = value end
    end
    if type(executor) == "string" and executor ~= "" then
        params = params .. "&executor=" .. vxEncode(vxSub(executor, 1, 40))
    end
    -- Device identity only: gethwid, then getserial, then the client's own analytics id.
    local hwid = nil
    if type(gethwid) == "function" then
        local ok, value = vxPcall(gethwid)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid and type(getserial) == "function" then
        local ok, value = vxPcall(getserial)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid and type(syn) == "table" and type(syn.get_hwid) == "function" then
        local ok, value = vxPcall(function() return syn.get_hwid() end)
        if ok and type(value) == "string" and value ~= "" then hwid = value end
    end
    if not hwid then
        local serviceOk, analytics = vxPcall(function() return game:GetService("RbxAnalyticsService") end)
        if serviceOk and analytics then
            local ok, value = vxPcall(function() return analytics:GetClientId() end)
            if ok and type(value) == "string" and value ~= "" then hwid = value end
        end
    end
    if type(hwid) == "string" and hwid ~= "" then
        params = params .. "&hwid=" .. vxEncode(vxSub(hwid, 1, 96))
    end
    return params .. vxPlaceParam()
end

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
    if vxDumpStable and string.dump ~= vxDump then add("dump_swapped") end
    if vxErrorStable and error ~= vxError then add("error_swapped") end
    if vxSetHookStable and (type(debug) ~= "table" or debug.sethook ~= vxSetHook) then add("hook_swapped") end
    if vxGetHookStable and (type(debug) ~= "table" or debug.gethook ~= vxGetHook) then add("hook_swapped") end
    if vxGetfenvStable and (type(getfenv) ~= "function" or getfenv ~= vxGetfenv) then add("fenv_swapped") end
    if vxSetfenvStable and (type(setfenv) ~= "function" or setfenv ~= vxSetfenv) then add("fenv_swapped") end
    -- The bootstrap marks getgenv with the watchdog it installed. If that mark
    -- survives but gethook reports a different function, the watchdog was
    -- replaced. Only trusted when getgenv returns the same table twice, since
    -- some executors build a fresh environment on every call.
    if vxGetHookStable and vxGetgenv then
        local hookOk, hookFn = vxPcall(vxGetHook)
        local envOk1, env1 = vxPcall(vxGetgenv)
        local envOk2, env2 = vxPcall(vxGetgenv)
        if hookOk and envOk1 and envOk2 and vxTypeOf(hookFn) == "function"
            and vxTypeOf(env1) == "table" and env1 == env2 and env1._vxwd ~= nil
            and env1._vxwd ~= hookFn then
            add("hook_installed")
        end
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
    if type(result.parts) ~= "table" then
        return nil, "payload_shape_invalid"
    end
    local count = #result.parts
    if count < 1 or count > 64 then
        return nil, "payload_shape_invalid"
    end
    local chunks = {}
    for index = 1, count do
        if type(result.parts[index]) ~= "string" then return nil, "payload_shape_invalid" end
        chunks[index] = vxBase64Decode(result.parts[index])
    end
    local cipher = vxConcat(chunks)
    -- The checksum covers the ciphertext as received. It proves the transfer was
    -- intact without publishing a checksum of the plaintext to calibrate against.
    if vxCrc32(cipher) ~= string.lower(tostring(result.tag or "")) then
        return nil, "payload_crc_mismatch"
    end
    local seed = tonumber(shield.key, 16)
    if not seed then return nil, "payload_shape_invalid" end
    local code = vxXor(cipher, seed)
    local prefix = "--[[vx:" .. shield.trace .. "]]"
    if vxSub(code, 1, #prefix) ~= prefix then return nil, "watermark_missing" end
    return code
end

local function vxRunPayload(token, userId, shield, report)
    if type(token) ~= "string" or token == "" then
        return error("[VoidedX] The server did not issue a delivery ticket.", 0)
    end
    if type(shield) ~= "table"
        or type(shield.key) ~= "string"
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
    payloadUrl = payloadUrl .. vxPlaceParam()

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

    if result.v ~= 5 then
        vxProgress(90, "Invalid payload")
        return error("[VoidedX] The payload server returned no script. Run the loader again.", 0)
    end
    local executionCode, reason = vxUnshield(result, shield)
    if not executionCode then
        vxReport(report, shield.trace, { reason or "payload_shape_invalid" })
        return error("[VoidedX] The payload failed its integrity check. Run the loader again.", 0)
    end
    vxProgress(95, "Integrity verified")

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
    local compileOk, scriptChunk, compileError = vxPcall(vxLoad, compileArg)
    if compileOk and not scriptChunk and compileArg ~= executionCode then
        -- Some executors accept chunk functions at probe time but fail on a
        -- real body; retry with the string before giving up.
        compileOk, scriptChunk, compileError = vxPcall(vxLoad, executionCode)
    end
    if (not compileOk or not scriptChunk) and vxLoadAlt and vxLoadAlt ~= vxLoad then
        local altOk, altChunk, altError = vxPcall(vxLoadAlt, executionCode)
        if altOk and altChunk then
            compileOk, scriptChunk = true, altChunk
        elseif not compileError then
            compileError = altError
        end
    end
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
${robloxOnlyGuard()}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options)}

local ok, response = vxPcall(function()
    return vxHttpGet(
        game,
        "${verifyBase}?id=${encodeURIComponent(id)}" ..
        "&key=" .. HttpService:UrlEncode(${luaString(key)}) ..
        vxClientParams(player)
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
${robloxOnlyGuard()}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
${buildPayloadRuntime(origin, options)}
local verifyUrl = ${luaString(verifyUrl)} .. vxClientParams(player)

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
