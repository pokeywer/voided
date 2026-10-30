// Loader-source obfuscation.
//
// packGeneratedLoader runs this once per delivery so the chunk a gate response
// releases is not a readable copy of the loader. Every local is renamed, every
// string literal moves into an encoded table, comments and whitespace are
// dropped, and the result is minified. It is the same program with the same
// behaviour; only the text you can read changes.

const RESERVED = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while'
]);

const MULTI_OPS = [
    '...', '..=', '//=', '<<=', '>>=', '==', '~=', '<=', '>=', '::', '..', '//',
    '<<', '>>', '+=', '-=', '*=', '/=', '%=', '^='
];

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

function pushUtf8(bytes, text) {
    const buffer = Buffer.from(text, 'utf8');
    for (let index = 0; index < buffer.length; index++) bytes.push(buffer[index]);
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
                const hex = body.slice(index + 1, index + 3);
                bytes.push(parseInt(hex, 16) & 0xFF);
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
                } else {
                    pushUtf8(bytes, 'u');
                }
                break;
            }
            default: {
                if (next !== undefined && /[0-9]/.test(next)) {
                    let digits = next;
                    while (digits.length < 3 && /[0-9]/.test(body[index + 1])) digits += body[++index];
                    bytes.push(parseInt(digits, 10) & 0xFF);
                } else if (next !== undefined) {
                    pushUtf8(bytes, next);
                }
            }
        }
    }

    return Buffer.from(bytes);
}

function encodeLuaByteString(buffer, key, step) {
    let literal = '"';
    for (let index = 0; index < buffer.length; index++) {
        const encoded = (buffer[index] + key + (index + 1) * step) & 0xFF;
        if (encoded >= 32 && encoded <= 126 && encoded !== 34 && encoded !== 92) {
            literal += String.fromCharCode(encoded);
        } else {
            literal += `\\${String(encoded).padStart(3, '0')}`;
        }
    }
    return `${literal}"`;
}

const NAME_SYLLABLES = [
    'ka', 'zu', 'mo', 're', 'ti', 'vo', 'ne', 'ra', 'sh', 'ul',
    'ix', 'om', 'ep', 'an', 'yi', 'qu', 'da', 'po', 'fi', 'xe'
];

const DECOY_MESSAGES = [
    'Voided: Doing this is not allowed.',
    '[VoidedX] Loader signature mismatch.',
    '[VoidedX] Checksum verification failed.',
    '[VoidedX] Session is not authorised.'
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function randomHex(length) {
    let out = '';
    for (let index = 0; index < length; index += 1) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return out;
}

function randomBody(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let index = 0; index < length; index += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
}

// A fixed `_0x` prefix is itself a fingerprint, so the naming scheme is drawn
// per build: hex, syllable pairs, base36, or single letters. The counter keeps
// names unique and every style starts with an underscore.
function createNameFactory(used) {
    const style = Math.floor(Math.random() * 4);
    const prefix = style === 0
        ? `_0x${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`
        : style === 1
            ? `_${pick(NAME_SYLLABLES)}${pick(NAME_SYLLABLES)}`
            : style === 2
                ? `_${Math.random().toString(36).slice(2, 9)}`
                : `_${'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]}`;
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

function collectDeclarations(tokens, used) {
    const declared = new Set();

    const declare = name => {
        if (!name || RESERVED.has(name)) return;
        declared.add(name);
        used.add(name);
    };

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type !== 'ident') continue;

        if (token.value === 'local') {
            let cursor = index + 1;
            if (tokens[cursor]?.type === 'ident' && tokens[cursor].value === 'function') {
                cursor++;
                if (tokens[cursor]?.type === 'ident') declare(tokens[cursor].value);
                continue;
            }
            while (cursor < tokens.length) {
                const name = tokens[cursor];
                if (name.type !== 'ident' || RESERVED.has(name.value)) break;
                declare(name.value);
                cursor++;
                if (tokens[cursor]?.type === 'op' && tokens[cursor].value === ',') { cursor++; continue; }
                break;
            }
        } else if (token.value === 'for') {
            let cursor = index + 1;
            while (cursor < tokens.length) {
                const name = tokens[cursor];
                if (name.type !== 'ident') break;
                declare(name.value);
                cursor++;
                if (tokens[cursor]?.type === 'op' && tokens[cursor].value === ',') { cursor++; continue; }
                break;
            }
        } else if (token.value === 'function') {
            let cursor = index + 1;
            while (cursor < tokens.length) {
                const part = tokens[cursor];
                if (part.type === 'op' && part.value === '(') break;
                if (part.type === 'ident') { cursor++; continue; }
                if (part.type === 'op' && (part.value === '.' || part.value === ':')) { cursor++; continue; }
                break;
            }
            if (tokens[cursor]?.type !== 'op' || tokens[cursor].value !== '(') continue;
            cursor++;
            while (cursor < tokens.length) {
                const part = tokens[cursor];
                if (part.type === 'op' && part.value === ')') break;
                if (part.type === 'ident') declare(part.value);
                cursor++;
            }
        }
    }

    return declared;
}

function collectProtectedTableKeys(tokens) {
    const protectedNames = new Set();
    const delimiters = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type === 'op') {
            if (token.value === '{' || token.value === '(' || token.value === '[') delimiters.push(token.value);
            else if (token.value === '}' || token.value === ')' || token.value === ']') delimiters.pop();
            continue;
        }
        if (token.type !== 'ident') continue;
        const next = tokens[index + 1];
        if (next?.type === 'op' && next.value === '=' && delimiters[delimiters.length - 1] === '{') {
            protectedNames.add(token.value);
        }
    }

    return protectedNames;
}

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

function emit(tokens, rename) {
    let output = '';
    let previous = '';
    let previousToken = null;
    let sinceBreak = 0;

    for (const token of tokens) {
        let text;

        if (token.type === 'ident') {
            let name = token.value;
            const isField = previousToken?.type === 'op'
                && (previousToken.value === '.' || previousToken.value === ':');
            if (!isField && rename.has(name)) name = rename.get(name);
            text = name;
        } else if (token.type === 'string') {
            text = `${token.refName}[${token.refIndex}]`;
        } else {
            text = token.value ?? token.raw;
        }

        if (needsSpace(previous, text)) output += ' ';
        // Break the minified body into ragged lines so no single line, token
        // run or indentation pattern is stable between builds. A break before
        // `(` would let Lua read the line as a continuation call of the previous
        // statement, so those positions stay on one line.
        sinceBreak += 1;
        if (output && sinceBreak > 12 && text[0] !== '(' && Math.random() < 0.18) {
            output += '\n' + ' '.repeat(Math.floor(Math.random() * 3));
            sinceBreak = 0;
        }
        output += text;
        previous = text;
        previousToken = token;
    }

    return output;
}

// Each table stores its strings in a shuffled order with its own byte schedule,
// so a recovered table neither mirrors source order nor shares a key with the
// other half of the strings.
function buildStringTableCode(tableName, entries, used) {
    if (entries.length === 0) return `${tableName}={}\n`;

    const nameFactory = createNameFactory(used);
    const key = 17 + Math.floor(Math.random() * 216);
    const step = 13 + Math.floor(Math.random() * 200);
    const listName = nameFactory();
    const rawName = nameFactory();
    const indexName = nameFactory();
    const byteName = nameFactory();
    const charName = nameFactory();

    const literals = entries.map(buffer => encodeLuaByteString(buffer, key, step));

    return `${listName}={${literals.join(',')}}
for ${indexName}=1,#${listName} do
local ${rawName}=${listName}[${indexName}]
local ${byteName}={}
for ${charName}=1,#${rawName} do ${byteName}[${charName}]=string.char(math.floor((string.byte(${rawName},${charName})-${key}-${charName}*${step})%256)) end
${listName}[${indexName}]=table.concat(${byteName})
end
${tableName}=${listName}
`;
}

// Dead branch that reads like the real gate handshake: an attacker who follows
// the opaque predicate by hand lands on a decoy URL and a decoy refusal.
function buildDecoyBlock(nameFactory) {
    const urlName = nameFactory();
    const messageName = nameFactory();
    const tokenName = nameFactory();
    const hexName = nameFactory();
    const fakeUrl = `https://voidedx.vercel.app/api/raw?id=${randomHex(12)}`
        + `&token=${randomBody(48)}&format=token-check&n=${randomHex(18)}`;
    return `local ${urlName}="${fakeUrl}"
local ${messageName}="${pick(DECOY_MESSAGES)}"
local ${tokenName}=string.match(${urlName},"[?&]token=([^&]+)") or ""
local ${hexName}=string.gsub(${tokenName},"[^%x]","")
if #${hexName}>17 then return error(${messageName},0) end
if #${hexName}==0 then return error(${messageName}.." (1)",0) end`;
}

function hashBytes(buffer, salt) {
    let hash = (0x811c9dc5 ^ salt) >>> 0;
    for (let index = 0; index < buffer.length; index += 1) {
        hash ^= buffer[index];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

function obfuscate(source) {
    const tokens = lex(source);

    const used = new Set();
    for (const token of tokens) {
        if (token.type === 'ident') used.add(token.value);
    }

    const declared = collectDeclarations(tokens, used);
    const protectedKeys = collectProtectedTableKeys(tokens);
    const nameFactory = createNameFactory(used);

    const rename = new Map();
    for (const name of declared) {
        if (protectedKeys.has(name)) continue;
        rename.set(name, nameFactory());
    }

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

    const tableNames = [nameFactory(), nameFactory()];
    const tables = [[], []];
    const refs = [];
    const salt = Math.floor(Math.random() * 0xFFFFFFFF);
    const order = unique.map((_, index) => index);
    for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        const value = order[index];
        order[index] = order[swap];
        order[swap] = value;
    }
    for (const slot of order) {
        const tableIndex = hashBytes(unique[slot], salt) & 1;
        tables[tableIndex].push(unique[slot]);
        refs[slot] = { refName: tableNames[tableIndex], refIndex: tables[tableIndex].length };
    }
    for (const token of tokens) {
        if (token.type !== 'string') continue;
        const ref = refs[token.slot];
        token.refName = ref.refName;
        token.refIndex = ref.refIndex;
    }

    const body = emit(tokens, rename);
    const seedName = nameFactory();
    const seed = 10000 + Math.floor(Math.random() * 90000);
    const container = `local ${tableNames.join(',')}
do
local ${seedName}=${seed}
if (${seedName}*${seedName}+${seedName})%2==1 then
${buildDecoyBlock(nameFactory)}
end
if (${seedName}*${seedName}+${seedName})%2==0 then
${tables.map((entries, index) => buildStringTableCode(tableNames[index], entries, used)).join('')}end
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
