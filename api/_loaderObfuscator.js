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

function createNameFactory(used) {
    return () => {
        let name;
        do {
            name = `_0x${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`;
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
        output += text;
        previous = text;
        previousToken = token;
    }

    return output;
}

function buildStringTable(tableName, entries, used) {
    if (entries.length === 0) return `local ${tableName}={}\n`;

    const nameFactory = createNameFactory(used);
    const key = 17 + Math.floor(Math.random() * 216);
    const step = 13 + Math.floor(Math.random() * 200);
    const listName = nameFactory();
    const rawName = nameFactory();
    const indexName = nameFactory();
    const byteName = nameFactory();
    const charName = nameFactory();

    const literals = entries.map(buffer => encodeLuaByteString(buffer, key, step));

    return `local ${tableName}={}
do
local ${listName}={${literals.join(',')}}
for ${indexName}=1,#${listName} do
local ${rawName}=${listName}[${indexName}]
local ${byteName}={}
for ${charName}=1,#${rawName} do ${byteName}[${charName}]=string.char(math.floor((string.byte(${rawName},${charName})-${key}-${charName}*${step})%256)) end
${listName}[${indexName}]=table.concat(${byteName})
end
${tableName}=${listName}
end
`;
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

    const stringTableName = nameFactory();
    const stringIndex = new Map();
    const entries = [];

    for (const token of tokens) {
        if (token.type !== 'string') continue;
        const bytes = decodeStringToken(token);
        const fingerprint = bytes.toString('hex');
        let index = stringIndex.get(fingerprint);
        if (index === undefined) {
            index = entries.length;
            entries.push(bytes);
            stringIndex.set(fingerprint, index);
        }
        token.refName = stringTableName;
        token.refIndex = index + 1;
    }

    const body = emit(tokens, rename);
    return `${buildStringTable(stringTableName, entries, used)}${body}`.trim();
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
