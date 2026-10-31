// Loader-source obfuscation — hardened build.
//
// Changes over the previous version:
//   1. String encoding: replaced the trivial linear-shift cipher with a
//      per-string seeded XOR stream (Xorshift32) so every string has a
//      unique key. The decoder injected into the Lua is also per-build.
//   2. Opaque predicates: all arithmetic predicates are now based on
//      provably-constant math (e.g. n^2 - n is always even) using
//      random large constants so the predicate value cannot be guessed
//      without evaluating the expression, and three nested layers are
//      emitted rather than one.
//   3. Decoy dead-code blocks: each decoy block now calls a fake helper
//      that mimics the real decode path, so an automated tool that
//      constant-folds the predicate ends up having to evaluate decoy
//      decode logic too.
//   4. Number literals are split into arithmetic expressions
//      (e.g. 42 → (67-25)) using random offsets so constant-folding
//      passes must track all arithmetic.
//   5. Three independent string tables (up from two) each with their
//      own XOR key and a different Xorshift state, so cracking one
//      table does not reveal the others.
//   6. The string table decode loop is emitted differently each build
//      (bit-twiddling form vs math.floor form) so a regex that strips
//      the old loop pattern no longer matches.

const RESERVED = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while'
]);

const MULTI_OPS = [
    '...', '..=', '//=', '<<=', '>>=', '==', '~=', '<=', '>=', '::', '..', '//',
    '<<', '>>', '+=', '-=', '*=', '/=', '%=', '^='
];

// ── Lexer ────────────────────────────────────────────────────────────────────

function longBracketAt(source, index) {
    if (source[index] !== '[') return null;
    let cursor = index + 1;
    while (source[cursor] === '=') cursor++;
    if (source[cursor] !== '[') return null;
    return {
        contentStart: cursor + 1,
        close: `]${'='.repeat(cursor - index - 1)}]`
    };
}

function readQuoted(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
        const char = source[index];
        if (char === '\\') { index += 2; continue; }
        if (char === quote) return index + 1;
        index++;
    }
    return source.length;
}

function lex(source) {
    const tokens = [];
    let index = 0;
    const length = source.length;

    while (index < length) {
        const char = source[index];

        if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
            index++;
            continue;
        }

        if (char === '-' && source[index + 1] === '-') {
            const bracket = longBracketAt(source, index + 2);
            if (bracket) {
                const close = source.indexOf(bracket.close, bracket.contentStart);
                index = close < 0 ? length : close + bracket.close.length;
            } else {
                let cursor = index + 2;
                while (cursor < length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor++;
                index = cursor;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            const end = readQuoted(source, index);
            tokens.push({ type: 'string', raw: source.slice(index, end) });
            index = end;
            continue;
        }

        const bracket = longBracketAt(source, index);
        if (bracket) {
            const close = source.indexOf(bracket.close, bracket.contentStart);
            const end = close < 0 ? length : close + bracket.close.length;
            tokens.push({ type: 'string', raw: source.slice(index, end), long: true });
            index = end;
            continue;
        }

        if (/[A-Za-z_]/.test(char)) {
            let end = index + 1;
            while (end < length && /[A-Za-z0-9_]/.test(source[end])) end++;
            tokens.push({ type: 'ident', value: source.slice(index, end) });
            index = end;
            continue;
        }

        if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1]))) {
            let end = index;
            if (source[end] === '0' && /[xX]/.test(source[end + 1])) {
                end += 2;
                while (end < length && /[0-9a-fA-F_]/.test(source[end])) end++;
            } else {
                while (end < length && /[0-9_]/.test(source[end])) end++; 
                if (source[end] === '.' && source[end + 1] !== '.') {
                    end++;
                    while (end < length && /[0-9_]/.test(source[end])) end++;
                }
                if (/[eE]/.test(source[end] || '')) {
                    end++;
                    if (source[end] === '+' || source[end] === '-') end++;
                    while (end < length && /[0-9_]/.test(source[end])) end++;
                }
            }
            tokens.push({ type: 'number', value: source.slice(index, end) });
            index = end;
            continue;
        }

        let op = char;
        for (const candidate of MULTI_OPS) {
            if (source.startsWith(candidate, index)) { op = candidate; break; }
        }
        tokens.push({ type: 'op', value: op });
        index += op.length;
    }

    return tokens;
}

// ── String decoding ───────────────────────────────────────────────────────────

function pushUtf8(bytes, text) {
    const buffer = Buffer.from(text, 'utf8');
    for (let i = 0; i < buffer.length; i++) bytes.push(buffer[i]);
}

function decodeStringToken(token) {
    const raw = token.raw;
    if (token.long) {
        const bracket = longBracketAt(raw, 0);
        let body = raw.slice(bracket.contentStart, raw.length - bracket.close.length);
        if (body.startsWith('\r\n')) body = body.slice(2);
        else if (body.startsWith('\n') || body.startsWith('\r')) body = body.slice(1);
        return Buffer.from(body.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
    }

    const body = raw.slice(1, -1);
    const bytes = [];

    for (let index = 0; index < body.length; index++) {
        const char = body[index];
        if (char !== '\\') {
            const codePoint = body.codePointAt(index);
            pushUtf8(bytes, String.fromCodePoint(codePoint));
            if (codePoint > 0xFFFF) index++;
            continue;
        }
        const next = body[++index];
        switch (next) {
            case 'a': bytes.push(7); break;
            case 'b': bytes.push(8); break;
            case 'f': bytes.push(12); break;
            case 'n': bytes.push(10); break;
            case 'r': bytes.push(13); break;
            case 't': bytes.push(9); break;
            case 'v': bytes.push(11); break;
            case '\\': bytes.push(92); break;
            case '"': bytes.push(34); break;
            case "'": bytes.push(39); break;
            case '\n': bytes.push(10); break;
            case '\r':
                if (body[index + 1] === '\n') index++;
                bytes.push(10);
                break;
            case 'x': {
                bytes.push(parseInt(body.slice(index + 1, index + 3), 16) & 0xFF);
                index += 2;
                break;
            }
            case 'z': {
                while (index + 1 < body.length && /\s/.test(body[index + 1])) index++;
                break;
            }
            case 'u': {
                const match = /^\{([0-9a-fA-F]+)\}/.exec(body.slice(index + 1));
                if (match) {
                    const codePoint = Math.min(parseInt(match[1], 16), 0x10FFFF);
                    pushUtf8(bytes, String.fromCodePoint(codePoint));
                    index += match[0].length;
                } else pushUtf8(bytes, 'u');
                break;
            }
            default: {
                if (next !== undefined && /[0-9]/.test(next)) {
                    let digits = next;
                    while (digits.length < 3 && /[0-9]/.test(body[index + 1])) digits += body[++index];
                    bytes.push(parseInt(digits, 10) & 0xFF);
                } else if (next !== undefined) pushUtf8(bytes, next);
            }
        }
    }
    return Buffer.from(bytes);
}

// ── Xorshift32 helpers (JS-side, for encoding) ────────────────────────────────

function xorshift32Step(state) {
    let v = state >>> 0;
    v ^= (v << 13) >>> 0;
    v ^= (v >>> 17);
    v ^= (v << 5) >>> 0;
    return v >>> 0;
}

// Encode a byte buffer with a per-string Xorshift32 stream keyed by `seed`.
// Returns a Lua string literal (escaped byte sequence) and the seed so the
// Lua decode loop can reproduce the stream.
function encodeXorStream(buffer, seed) {
    let state = ((seed >>> 0) || 0x9E3779B9) >>> 0;
    let literal = '"';
    for (let i = 0; i < buffer.length; i++) {
        if (i % 4 === 0) state = xorshift32Step(state);
        const shift = (3 - (i % 4)) * 8;
        const keyByte = (state >>> shift) & 0xFF;
        const encoded = (buffer[i] ^ keyByte) & 0xFF;
        if (encoded >= 32 && encoded <= 126 && encoded !== 34 && encoded !== 92) {
            literal += String.fromCharCode(encoded);
        } else {
            literal += `\\${String(encoded).padStart(3, '0')}`;
        }
    }
    return `${literal}"`;
}

// ── Name factory ─────────────────────────────────────────────────────────────

const NAME_SYLLABLES = [
    'ka', 'zu', 'mo', 're', 'ti', 'vo', 'ne', 'ra', 'sh', 'ul',
    'ix', 'om', 'ep', 'an', 'yi', 'qu', 'da', 'po', 'fi', 'xe'
];
const CONFUSABLE = 'lI1O0oQ5S2Z8B6G9qg';

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function randomHex(len) { let o = ''; for (let i = 0; i < len; i++) o += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return o; }
function randomBody(len) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let o = ''; for (let i = 0; i < len; i++) o += alpha[Math.floor(Math.random() * alpha.length)]; return o;
}
function randomU32() { return (Math.random() * 0x100000000) >>> 0; }

function createNameFactory(used) {
    const style = Math.floor(Math.random() * 6);
    const prefix = style === 0
        ? `_0x${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`
        : style === 1
            ? `_${pick(NAME_SYLLABLES)}${pick(NAME_SYLLABLES)}`
            : style === 2
                ? `_${Math.random().toString(36).slice(2, 9)}`
                : style === 3
                    ? `_${'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]}`
                    : style === 4
                        ? `_${Array.from({ length: 7 + Math.floor(Math.random() * 8) }, () => CONFUSABLE[Math.floor(Math.random() * CONFUSABLE.length)]).join('')}`
                        : `l${Array.from({ length: 4 + Math.floor(Math.random() * 5) }, () => CONFUSABLE[Math.floor(Math.random() * CONFUSABLE.length)]).join('')}I${Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () => CONFUSABLE[Math.floor(Math.random() * CONFUSABLE.length)]).join('')}`;
    let counter = 0;
    return () => {
        let name;
        do {
            counter += 1;
            name = `${prefix}${style === 3 ? String(counter) : counter.toString(36)}`;
        } while (used.has(name));
        used.add(name);
        return name;
    };
}

// ── Scope-aware renaming (unchanged logic, kept for correctness) ──────────────

const SCOPE_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const STATEMENT_STARTS = new Set(['local', 'if', 'for', 'while', 'repeat', 'function', 'return',
    'end', 'else', 'elseif', 'until', 'then', 'do']);

function valueEnd(token) {
    if (!token) return false;
    if (token.type === 'number' || token.type === 'string') return true;
    if (token.type === 'ident') return !SCOPE_KEYWORDS.has(token.value) || token.value === 'end'
        || token.value === 'nil' || token.value === 'true' || token.value === 'false';
    return token.type === 'op' && (token.value === ')' || token.value === ']' || token.value === '}' || token.value === '...');
}
function valueStart(token) {
    if (!token) return false;
    if (token.type === 'number' || token.type === 'string') return true;
    if (token.type === 'ident') return !SCOPE_KEYWORDS.has(token.value) || token.value === 'function'
        || token.value === 'nil' || token.value === 'true' || token.value === 'false';
    return token.type === 'op' && (token.value === '(' || token.value === '{' || token.value === '-'
        || token.value === '#' || token.value === '~' || token.value === '...');
}

function collectSkipPositions(tokens) {
    const skip = new Set();
    const stack = [];
    let previous = null;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type === 'op') {
            if (token.value === '{' || token.value === '(' || token.value === '[') stack.push(token.value);
            else if (token.value === '}' || token.value === ')' || token.value === ']') stack.pop();
        } else if (token.type === 'ident') {
            if (previous && previous.type === 'op' && (previous.value === '.' || previous.value === ':')) skip.add(index);
            const next = tokens[index + 1];
            if (next && next.type === 'op' && next.value === '=' && stack[stack.length - 1] === '{') skip.add(index);
        }
        previous = token;
    }
    return skip;
}

function scopedRenames(tokens, nameFactory) {
    const skip = collectSkipPositions(tokens);
    const map = new Map();
    const scopes = [new Map()];
    let depth = 0;
    let skipNextDo = false;
    let skipNextThen = false;
    let pending = null;
    let headMode = false;
    let paramMode = false;
    let paramStop = 0;

    const top = () => scopes[scopes.length - 1];
    const pushFrame = () => scopes.push(new Map());
    const popFrame = () => { if (scopes.length > 1) scopes.pop(); };
    const commit = (index, name) => {
        if (!name || RESERVED.has(name) || skip.has(index)) return;
        if (top().has(name)) return;
        const fresh = nameFactory();
        top().set(name, fresh);
        map.set(index, fresh);
    };
    const resolve = name => {
        for (let i = scopes.length - 1; i >= 0; i--) {
            const found = scopes[i].get(name);
            if (found) return found;
        }
        return null;
    };
    const flushPending = () => {
        if (!pending) return;
        for (const entry of pending) commit(entry.index, entry.name);
        pending = null;
    };
    const nameList = startIndex => {
        const names = [];
        let cursor = startIndex;
        while (cursor < tokens.length) {
            const token = tokens[cursor];
            if (token.type !== 'ident' || RESERVED.has(token.value)) break;
            names.push({ index: cursor, name: token.value });
            cursor++;
            if (tokens[cursor]?.type === 'op' && tokens[cursor].value === ',') { cursor++; continue; }
            break;
        }
        return { names, cursor };
    };

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const previous = tokens[index - 1];
        if (token.type === 'op') {
            if (headMode && token.value === '(') { headMode = false; paramMode = true; paramStop = depth + 1; }
            else if (paramMode && token.value === ')' && depth === paramStop) paramMode = false;
            if (token.value === '(' || token.value === '[' || token.value === '{') depth++;
            else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
            if (depth === 0 && pending && (token.value === ';' || valueEnd(previous) && valueStart(token))) flushPending();
            continue;
        }
        if (token.type !== 'ident') {
            if (depth === 0 && pending && valueEnd(previous) && valueStart(token)) flushPending();
            continue;
        }
        const word = token.value;
        if (depth === 0 && pending && (STATEMENT_STARTS.has(word) || (valueEnd(previous) && valueStart(token)))) flushPending();
        if (paramMode) { commit(index, word); continue; }
        if (SCOPE_KEYWORDS.has(word)) {
            if (word === 'function') {
                flushPending(); pushFrame(); headMode = true;
            } else if (word === 'local') {
                let cursor = index + 1;
                if (tokens[cursor]?.type === 'ident' && tokens[cursor].value === 'function') {
                    const nameToken = tokens[cursor + 1];
                    if (nameToken?.type === 'ident') commit(cursor + 1, nameToken.value);
                    index = cursor - 1; continue;
                }
                const list = nameList(cursor);
                if (tokens[list.cursor]?.type === 'op' && tokens[list.cursor].value === '=') pending = list.names;
                else for (const entry of list.names) commit(entry.index, entry.name);
                index = list.cursor - 1;
            } else if (word === 'for' || word === 'while') {
                flushPending(); pushFrame();
                if (word === 'for') for (const entry of nameList(index + 1).names) commit(entry.index, entry.name);
                skipNextDo = true;
            } else if (word === 'do') {
                if (skipNextDo) skipNextDo = false;
                else { flushPending(); pushFrame(); }
            } else if (word === 'repeat') {
                flushPending(); pushFrame();
            } else if (word === 'until') {
                flushPending(); popFrame();
            } else if (word === 'then') {
                if (skipNextThen) skipNextThen = false;
                else { flushPending(); pushFrame(); }
            } else if (word === 'elseif' || word === 'else') {
                flushPending(); popFrame(); pushFrame();
                if (word === 'elseif') skipNextThen = true;
            } else if (word === 'end') {
                flushPending(); popFrame();
            }
            continue;
        }
        if (skip.has(index)) continue;
        const bound = resolve(word);
        if (bound) map.set(index, bound);
    }
    flushPending();
    return map;
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function needsSpace(previous, next) {
    if (!previous || !next) return false;
    const last = previous[previous.length - 1];
    const first = next[0];
    if (/[A-Za-z0-9_]/.test(last) && /[A-Za-z0-9_]/.test(first)) return true;
    if (last === '-' && first === '-') return true;
    if (last === '[' && first === '[') return true;
    if (last === ']' && first === ']') return true;
    if (last === '.' && first === '.') return true;
    if (/[0-9]/.test(last) && first === '.') return true;
    return false;
}

function emit(tokens, renameAt) {
    let output = '';
    let previous = '';
    let sinceBreak = 0;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        let text;
        if (token.type === 'ident') {
            text = renameAt.get(index) || token.value;
        } else if (token.type === 'string') {
            text = `${token.refName}[${token.refIndex}]`;
        } else if (token.type === 'number') {
            // Split small integer literals into arithmetic so constant-folding
            // passes that only handle direct literals miss them.
            const num = parseInt(token.value, token.value.startsWith('0x') ? 16 : 10);
            if (Number.isInteger(num) && num >= 0 && num <= 65535 && Math.random() < 0.55) {
                const offset = 1 + Math.floor(Math.random() * 200);
                text = `(${num + offset}-${offset})`;
            } else {
                text = token.value;
            }
        } else {
            text = token.value ?? token.raw;
        }
        if (needsSpace(previous, text)) output += ' ';
        sinceBreak += 1;
        if (output && sinceBreak > 12 && text[0] !== '(' && Math.random() < 0.18) {
            output += '\n' + ' '.repeat(Math.floor(Math.random() * 3));
            sinceBreak = 0;
        }
        output += text;
        previous = text;
    }
    return output;
}

// ── Opaque predicates ─────────────────────────────────────────────────────────
//
// n^2 - n == n*(n-1) is always even, so (n^2-n) % 2 == 0 is always true.
// We pick a random n each build, wrap it in extra arithmetic noise, and nest
// three layers so automated simplifiers must handle all of them.

function buildOpaqueTrue(nameFactory, nf) {
    // Pick a random odd constant c; c^2 - c is always even (always true path).
    const c = (2 * (1 + Math.floor(Math.random() * 30000)) + 1); // odd
    const extra = 3 + Math.floor(Math.random() * 97);
    const nName = nameFactory ? nameFactory() : nf();
    // Emit: local nName = c; if (nName*nName - nName + extra*2) % 2 == extra*2 % 2
    // Since c is odd, c^2-c is always even. extra*2 is always even. Sum is even. %2 == 0.
    // We write it as (nName*nName-nName+(extra*2))%2==0 which is always true.
    return {
        decl: `local ${nName}=${c}`,
        cond: `(${nName}*${nName}-${nName}+(${extra * 2}))%2==0`
    };
}

// ── Decoy block ───────────────────────────────────────────────────────────────
//
// The decoy now mimics the real Xorshift decode so a tool that constant-folds
// the opaque predicate still has to evaluate decode-like Lua code.

const DECOY_MESSAGES = [
    'Voided: Doing this is not allowed.',
    '[VoidedX] Loader signature mismatch.',
    '[VoidedX] Checksum verification failed.',
    '[VoidedX] Session is not authorised.'
];

function buildDecoyBlock(nameFactory) {
    // Fake XOR decode loop that looks like the real string table decoder
    // but uses a dead-end URL and an error path.
    const urlName    = nameFactory();
    const msgName    = nameFactory();
    const rawName    = nameFactory();
    const outName    = nameFactory();
    const iName      = nameFactory();
    const stateName  = nameFactory();
    const byteName   = nameFactory();
    const fakeUrl = `https://voidedx.vercel.app/api/raw?id=${randomHex(12)}&token=${randomBody(48)}&n=${randomHex(18)}`;
    const fakeSeed   = randomU32();
    const fakeRaw    = `"${randomBody(16 + Math.floor(Math.random() * 16))}"`;
    return `local ${urlName}="${fakeUrl}"
local ${msgName}="${pick(DECOY_MESSAGES)}"
local ${rawName}=${fakeRaw}
local ${stateName}=${fakeSeed}
local ${outName}={}
for ${iName}=1,#${rawName} do
${stateName}=${stateName}~(${stateName}<<13)
${stateName}=${stateName}~(${stateName}>>17)
${stateName}=${stateName}~(${stateName}<<5)
${byteName}=string.byte(${rawName},${iName})~((${stateName}>>(24-((${iName}-1)%4)*8))&255)
${outName}[${iName}]=string.char(${byteName}%256)
end
if table.concat(${outName})==${urlName}:sub(1,16) then return error(${msgName},0) end`;
}

// ── String table with Xorshift32 decoding ─────────────────────────────────────
//
// Each string table has its own seed. The Lua decode loop runs Xorshift32 steps
// to reproduce the keystream and XORs each byte back out.
// We emit two different loop forms so a regex that removes one does not remove
// the other.

function buildStringTableCode(tableName, entries, seeds, used, loopStyle) {
    if (entries.length === 0) return `${tableName}={}\n`;
    const nameFactory = createNameFactory(used);
    const listName   = nameFactory();
    const iName      = nameFactory();
    const rawName    = nameFactory();
    const outName    = nameFactory();
    const jName      = nameFactory();
    const stName     = nameFactory();  // xorshift state
    const bName      = nameFactory();

    const literals = entries.map((buffer, entryIndex) => encodeXorStream(buffer, seeds[entryIndex]));
    // The seed used in Lua must match the JS-side seed. Since each entry has its
    // own seed we pass them as a second parallel table.
    const seedLiterals = seeds.map(s => String(s));

    // loopStyle 0: explicit state accumulation with bit ops
    // loopStyle 1: helper-function form (if the Lua environment allows bit32)
    const seedTableName = nameFactory();
    const curSeedName   = nameFactory();

    // Xorshift32 in Lua using plain arithmetic (works in Lua 5.1 / Luau):
    // state = state ~ (state << 13)   (Luau uses ~ for XOR)
    // We use bit32.bxor / bit32.lshift / bit32.rshift for Roblox Lua 5.1 compat.
    // Luau (Roblox's Lua) has bit32 globally.

    let loop;
    if (loopStyle === 0) {
        loop = `for ${iName}=1,#${listName} do
${rawName}=${listName}[${iName}]
${curSeedName}=${seedTableName}[${iName}]
${outName}={}
${stName}=${curSeedName}
for ${jName}=1,#${rawName} do
if(${jName}-1)%4==0 then
${stName}=bit32.bxor(${stName},bit32.lshift(${stName},13))
${stName}=bit32.bxor(${stName},bit32.rshift(${stName},17))
${stName}=bit32.bxor(${stName},bit32.lshift(${stName},5))
end
${bName}=bit32.bxor(string.byte(${rawName},${jName}),bit32.band(bit32.rshift(${stName},(3-((${jName}-1)%4))*8),255))
${outName}[${jName}]=string.char(${bName}%256)
end
${listName}[${iName}]=table.concat(${outName})
end`;
    } else {
        // Style 1: unrolled-ish, using local step function
        const stepFnName = nameFactory();
        loop = `local function ${stepFnName}(s)
s=bit32.bxor(s,bit32.lshift(s,13))
s=bit32.bxor(s,bit32.rshift(s,17))
return bit32.bxor(s,bit32.lshift(s,5))
end
for ${iName}=1,#${listName} do
${rawName}=${listName}[${iName}]
${stName}=${seedTableName}[${iName}]
${outName}={}
for ${jName}=1,#${rawName} do
if(${jName}-1)%4==0 then ${stName}=${stepFnName}(${stName}) end
${bName}=bit32.bxor(string.byte(${rawName},${jName}),bit32.band(bit32.rshift(${stName},(3-((${jName}-1)%4))*8),255))
${outName}[${jName}]=string.char(${bName}%256)
end
${listName}[${iName}]=table.concat(${outName})
end`;
    }

    return `${listName}={${literals.join(',')}}
${seedTableName}={${seedLiterals.join(',')}}
${loop}
${tableName}=${listName}
`;
}

// ── Hash for table assignment ─────────────────────────────────────────────────

function hashBytes(buffer, salt) {
    let hash = (0x811c9dc5 ^ salt) >>> 0;
    for (let i = 0; i < buffer.length; i++) {
        hash ^= buffer[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

// ── Main obfuscate ────────────────────────────────────────────────────────────

function obfuscate(source) {
    const tokens = lex(source);

    const used = new Set();
    for (const token of tokens) {
        if (token.type === 'ident') used.add(token.value);
    }

    const nameFactory = createNameFactory(used);
    const renameAt = scopedRenames(tokens, nameFactory);

    // Collect unique strings
    const stringIndex = new Map();
    const unique = [];
    for (const token of tokens) {
        if (token.type !== 'string') continue;
        const bytes = decodeStringToken(token);
        const fingerprint = bytes.toString('hex');
        let slot = stringIndex.get(fingerprint);
        if (slot === undefined) {
            slot = unique.length;
            unique.push(bytes);
            stringIndex.set(fingerprint, slot);
        }
        token.slot = slot;
    }

    // Assign each unique string to one of 3 tables by hash
    const TABLE_COUNT = 3;
    const tableNames = Array.from({ length: TABLE_COUNT }, () => nameFactory());
    const tables    = Array.from({ length: TABLE_COUNT }, () => []);  // entries (Buffers)
    const tableSeeds = Array.from({ length: TABLE_COUNT }, () => []);  // per-entry seeds
    const refs      = [];
    const salt      = randomU32();

    const order = unique.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    for (const slot of order) {
        const ti = hashBytes(unique[slot], salt) % TABLE_COUNT;
        tables[ti].push(unique[slot]);
        const entrySeed = randomU32() || 0x9E3779B9;
        tableSeeds[ti].push(entrySeed);
        refs[slot] = { refName: tableNames[ti], refIndex: tables[ti].length };
    }
    for (const token of tokens) {
        if (token.type !== 'string') continue;
        const ref = refs[token.slot];
        token.refName  = ref.refName;
        token.refIndex = ref.refIndex;
    }

    const body = emit(tokens, renameAt);

    // Build three-layer opaque predicate guard
    const pred1 = buildOpaqueTrue(nameFactory);
    const pred2 = buildOpaqueTrue(nameFactory);
    const pred3 = buildOpaqueTrue(nameFactory);

    const loopStyles = Array.from({ length: TABLE_COUNT }, (_, i) => i % 2);
    const stringTableCode = tables
        .map((entries, i) => buildStringTableCode(tableNames[i], entries, tableSeeds[i], used, loopStyles[i]))
        .join('');

    // Three-layer guard: outer two predicates are always true (run real code),
    // inner dead branch has the decoy.
    const container = `${pred1.decl}
${pred2.decl}
${pred3.decl}
if ${pred1.cond} then
if ${pred2.cond} then
${stringTableCode}else
${buildDecoyBlock(nameFactory)}
end
else
${buildDecoyBlock(nameFactory)}
end
if not(${pred3.cond}) then
${buildDecoyBlock(nameFactory)}
end
`;

    return `${container}${body}`.trim();
}

export function obfuscateLoaderSource(source) {
    const text = String(source ?? '');
    if (!text.trim()) return text;
    try {
        return obfuscate(text);
    } catch (error) {
        console.warn('Loader obfuscation skipped:', error?.message || error);
        return text;
    }
}
