const DEFAULT_MESSAGE = "VOIDEDX: payload integrity check failed";
function rngFrom(seed) {
    let s = (seed ^ 0x9e3779b9) >>> 0;
    if (s === 0)
        s = 0x85ebca6b;
    return () => {
        s = (Math.imul(s ^ (s >>> 15), s | 1)) >>> 0;
        s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) >>> 0) ^ s;
        return ((s >>> 0) % 1000003) / 1000003;
    };
}
const STD_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function shuffle(alpha, rng) {
    const a = alpha.split("");
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a.join("");
}
/** 3 bytes -> 4 chars, zero-padded so every group is complete. */
function encode64(bytes, alpha) {
    const pad = (3 - (bytes.length % 3)) % 3;
    const filled = bytes.concat(Array.from({ length: pad }, () => 0));
    const out = [];
    for (let i = 0; i < filled.length; i += 3) {
        const b0 = filled[i];
        const b1 = filled[i + 1];
        const b2 = filled[i + 2];
        out.push(alpha[b0 >> 2], alpha[((b0 & 0x03) << 4) | (b1 >> 4)], alpha[((b1 & 0x0f) << 2) | (b2 >> 6)], alpha[b2 & 0x3f]);
    }
    return { text: out.join(""), pad };
}
function cipher(bytes, keys, step, rot) {
    const nk = keys.length;
    return bytes.map((b, i) => (b + keys[i % nk] + ((i * step) & 0xff) + rot) & 0xff);
}
/** Rolling hash mod 2^31-1, exactly reproduced in the emitted Luau (doubles are safe here). */
function hashBytes(bytes, mult) {
    let h = 0x811c9dc5 & 0x7fffffff;
    for (const b of bytes)
        h = (h * mult + b) % 2147483647;
    return h >>> 0;
}
function toBytes(text) {
    return Array.from(Buffer.from(text, "utf8"));
}
function luaBytes(text) {
    return JSON.stringify(text);
}
function numericNoise(value, rng) {
    const roll = Math.floor(rng() * 4);
    if (roll === 0) {
        const a = 100 + Math.floor(rng() * 900);
        return `(${a}+${value - a})`;
    }
    if (roll === 1) {
        const a = 2 + Math.floor(rng() * 7);
        return `(${a}*${Math.floor(value / a)}+${value % a})`;
    }
    if (roll === 2)
        return `(${value}+0)`;
    const hex = value.toString(16).toUpperCase();
    return `0x${hex}`;
}
function chunkOrder(count, rng) {
    const idx = Array.from({ length: count }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
}
function emitCopy(name, encoded, pad, keys, step, rot, alpha, rng) {
    const chunkCount = 3 + Math.floor(rng() * 5);
    const sizes = [];
    let remaining = encoded.length;
    for (let i = 0; i < chunkCount; i++) {
        const share = Math.max(16, Math.floor((remaining / (chunkCount - i)) * (0.7 + rng() * 0.6)));
        const size = Math.min(share, remaining);
        sizes.push(size);
        remaining -= size;
    }
    if (remaining > 0)
        sizes[sizes.length - 1] += remaining;
    const decls = [];
    let cursor = 0;
    const parts = [];
    const pieceDecls = [];
    sizes.forEach((size, i) => {
        const slice = encoded.slice(cursor, cursor + size);
        cursor += size;
        const piece = `${name}p${i}`;
        parts.push(piece);
        pieceDecls.push(`local ${piece}=${luaBytes(slice)}`);
    });
    // Concatenation must follow the original sequence; the per-build shuffle only reorders the
    // declarations, so the layout differs between builds without changing the payload.
    for (let i = pieceDecls.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pieceDecls[i], pieceDecls[j]] = [pieceDecls[j], pieceDecls[i]];
    }
    decls.push(...pieceDecls);
    const alphaVar = `${name}a`;
    decls.push(`local ${alphaVar}=${luaBytes(alpha)}`);
    const invVar = `${name}i`;
    decls.push(`local ${invVar}={} for _x=1,64 do ${invVar}[string.byte(${alphaVar},_x)]=_x-1 end`);
    const keyVar = `${name}k`;
    decls.push(`local ${keyVar}={${keys.map((k) => numericNoise(k, rng)).join(",")}}`);
    const stepVar = `${name}w`;
    decls.push(`local ${stepVar}=${numericNoise(step, rng)}`);
    const rotVar = `${name}r`;
    decls.push(`local ${rotVar}=${numericNoise(rot, rng)}`);
    const nkVar = `${name}n`;
    decls.push(`local ${nkVar}=${keys.length}`);
    const decodeFn = `${name}d`;
    decls.push(`local ${name}s=${parts.join("..")}`);
    decls.push(`local function ${decodeFn}(s)
  local n=#s
  if n%4~=0 then return "" end
  local acc={}
  local out=0
  local w=0
  for i=1,n do
    local v=${invVar}[string.byte(s,i)]
    if v==nil then return "" end
    out=out*64+v
    w=w+1
    if w==4 then
      acc[#acc+1]=math.floor(out/65536)%256
      acc[#acc+1]=math.floor(out/256)%256
      acc[#acc+1]=out%256
      out=0
      w=0
    end
  end
  local pos=#acc-${numericNoise(pad, rng)}
  if pos<0 then return "" end
  local chars={}
  for i=1,pos do
    local k=${keyVar}[((i-1)%${nkVar})+1]
    chars[i]=string.char((acc[i]-k-((i-1)*${stepVar})%256-${rotVar})%256)
  end
  return table.concat(chars)
end`);
    return { decls };
}
/**
 * Wraps a finished protected script in an integrity envelope: the source is stored as one or two
 * independently keyed copies, each decoded and hash-checked before anything executes.
 */
export function wrapWithIntegrity(source, options = {}) {
    const mode = options.mode ?? "mirror";
    if (mode === "off")
        return { code: source, copies: 0, bytes: source.length, chunkCount: 0 };
    const failMode = options.failMode ?? "error";
    const message = options.message ?? DEFAULT_MESSAGE;
    const seed = (options.seed ?? 0x5eed) >>> 0;
    const rng = rngFrom(seed);
    const bytes = toBytes(source);
    const length = bytes.length;
    const hashA = hashBytes(bytes, 33);
    const hashB = hashBytes(bytes, 131);
    const copyCount = mode === "basic" ? 1 : Math.max(1, Math.min(8, options.copies ?? 2));
    const copyIndexes = Array.from({ length: copyCount }, (_, i) => i);
    const decls = [];
    const bail = "vxbail";
    const hfn = "vxhash";
    const qfn = "vxhash2";
    const emitVariant = (name, payload) => {
        const keys = Array.from({ length: 3 + Math.floor(rng() * 3) }, () => 1 + Math.floor(rng() * 254));
        const step = 3 + Math.floor(rng() * 30);
        const rot = 1 + Math.floor(rng() * 250);
        const alpha = shuffle(STD_ALPHA, rng);
        const enc = encode64(cipher(payload, keys, step, rot), alpha);
        decls.push(...emitCopy(name, enc.text, enc.pad, keys, step, rot, alpha, rng).decls);
    };
    copyIndexes.forEach((index) => emitVariant(`vxc${index}`, bytes));
    // A decoy copy holds a deliberately mutated version of the program and is checked against its
    // own signature: patching it into the real payload, or editing the real one to match it, trips.
    const withDecoy = mode === "mirror" && copyCount > 1 && options.decoy !== false;
    let decoyHash = 0;
    if (withDecoy) {
        const mutated = bytes.slice();
        const at = Math.floor(mutated.length / 2);
        mutated[at] = (mutated[at] + 7) & 0xff;
        decoyHash = hashBytes(mutated, 33);
        emitVariant("vxcd", mutated);
    }
    decls.push(`local function ${hfn}(t)
  local h=${0x811c9dc5 & 0x7fffffff}
  for i=1,#t do h=(h*33+t:byte(i))%2147483647 end
  return h
end`);
    decls.push(`local function ${qfn}(t)
  local h=${0x811c9dc5 & 0x7fffffff}
  for i=1,#t do h=(h*131+t:byte(i))%2147483647 end
  return h
end`);
    const failCall = failMode === "error"
        ? `error(${luaStringSafe(message)} .. " [" .. vxc .. "]", 0)`
        : failMode === "decoy"
            ? `print("[VOIDEDX] verifying payload...")
    print("[VOIDEDX] signature ok")
    print("[VOIDEDX] payload unavailable, check status page")`
            : `return false`;
    const body = [
        `local vxbad=nil`,
        `local function ${bail}(vxc)`,
        `  if vxbad==nil then vxbad=vxc end`,
        `  ${failCall}`,
        `  return false`,
        `end`,
    ];
    for (const d of decls)
        body.push(d);
    copyIndexes.forEach((index) => {
        const name = `vxc${index}`;
        body.push(`local ${name}b=${name}d(${name}s)`);
        body.push(`if ${name}b=="" then ${bail}("0x21") end`);
        body.push(`if #${name}b~=${numericNoise(length, rng)} then ${bail}("0x22") end`);
        body.push(`if ${hfn}(${name}b)~=${numericNoise(hashA, rng)} then ${bail}("0x23") end`);
        body.push(`if ${qfn}(${name}b)~=${numericNoise(hashB, rng)} then ${bail}("0x24") end`);
    });
    for (let i = 1; i < copyCount; i++) {
        body.push(`if vxc0b~=vxc${i}b then ${bail}("0x25") end`);
    }
    if (withDecoy) {
        body.push(`local vxdb=vxcdd(vxcds)`);
        body.push(`if vxdb=="" then ${bail}("0x29") end`);
        body.push(`if ${hfn}(vxdb)~=${numericNoise(decoyHash, rng)} then ${bail}("0x2a") end`);
        body.push(`if vxdb==vxc0b then ${bail}("0x2b") end`);
    }
    const probeCount = Math.max(0, Math.min(6, options.probes ?? (mode === "mirror" ? 3 : 1)));
    for (let p = 0; p < probeCount; p++) {
        const probeHash = `${hfn}(vxc0b)`;
        const target = numericNoise(hashA, rng);
        if (p % 3 === 0)
            body.push(`if ${probeHash}~=${target} then ${bail}("0x2c") end`);
        else if (p % 3 === 1)
            body.push(`if not (${target}==${probeHash}) then ${bail}("0x2d") end`);
        else
            body.push(`local vxpgood=${probeHash}==${target} if vxpgood~=true then ${bail}("0x2e") end`);
    }
    body.push(`if vxbad~=nil then return end`);
    body.push(`local vxchunk=loadstring and loadstring or load`);
    body.push(`if type(vxchunk)~="function" then ${bail}("0x27") return end`);
    body.push(`local vxok,vxfn=pcall(vxchunk,vxc0b,"VoidedX")`);
    body.push(`if not vxok or type(vxfn)~="function" then ${bail}("0x28") return end`);
    body.push(`return vxfn(...)`);
    const code = `do\n${body.join("\n")}\nend`;
    return { code, copies: copyCount + (withDecoy ? 1 : 0), bytes: length, chunkCount: decls.length };
}
function luaStringSafe(value) {
    return JSON.stringify(value);
}
//# sourceMappingURL=envelope.js.map