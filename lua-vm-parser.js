// Lua/Luau tokenizer, parser, and scope analyzer for the VoidedX VM engine.
//
// The parser accepts Lua 5.1 grammar plus the Luau extensions commonly used by
// Roblox scripts: continue, compound assignment, type annotations and aliases,
// if-expressions, string interpolation, `//`, bitwise operators, and `::`
// casts. Type information is parsed and discarded; runtime semantics come from
// the generated VM instruction stream.
//
// String literals are stored as byte strings: every character code is 0..255.
// Literal source characters are converted to UTF-8 bytes at scan time, and
// numeric escapes append their byte directly. This keeps serialized constants
// byte-accurate on every host.

export class LuaVmError extends Error {
    constructor(message, line = 0, column = 0) {
        super(line ? `${message} (line ${line})` : message);
        this.name = 'LuaVmError';
        this.line = line;
        this.column = column;
    }
}

const KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while'
]);

const MULTI_OPS = [
    '...', '..=', '//=', '>>=', '<<=',
    '..', '==', '~=', '<=', '>=', '::', '//', '<<', '>>',
    '+=', '-=', '*=', '/=', '%=', '^=', '->'
];

const SINGLE_OPS = new Set('+-*/%^#&~|<>=(){}[];:,.?@');

const BINARY_BP = {
    'or': [1, 1],
    'and': [2, 2],
    '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
    '|': [4, 4],
    '~': [5, 5],
    '&': [6, 6],
    '<<': [7, 7], '>>': [7, 7],
    '..': [9, 8],
    '+': [10, 10], '-': [10, 10],
    '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
    '^': [14, 13]
};

const UNARY_BP = 12;

function isNameStart(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isNamePart(code) {
    return isNameStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code) {
    return code >= 48 && code <= 57;
}

function isHexDigit(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function hexValue(code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    return code - 87;
}

function appendUtf8(bytes, codePoint) {
    if (codePoint < 0x80) {
        bytes.push(codePoint);
    } else if (codePoint < 0x800) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 63));
    } else if (codePoint < 0x10000) {
        bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 63), 0x80 | (codePoint & 63));
    } else {
        bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 63),
            0x80 | ((codePoint >> 6) & 63),
            0x80 | (codePoint & 63)
        );
    }
}

function bytesToString(bytes) {
    if (bytes.length === 0) return '';
    let out = '';
    const chunk = 0x2000;
    for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
    }
    return out;
}

function appendLiteralChar(bytes, source, pos) {
    const codePoint = source.codePointAt(pos);
    appendUtf8(bytes, codePoint);
    return codePoint > 0xffff ? 2 : 1;
}

class Tokenizer {
    constructor(source) {
        this.source = source;
        this.pos = 0;
        this.line = 1;
        this.column = 1;
        this.tokens = [];
    }

    error(message, line = this.line, column = this.column) {
        throw new LuaVmError(message, line, column);
    }

    peekChar(offset = 0) {
        return this.source.charCodeAt(this.pos + offset);
    }

    advance(count = 1) {
        for (let i = 0; i < count && this.pos < this.source.length; i++) {
            const code = this.source.charCodeAt(this.pos);
            this.pos++;
            if (code === 10) {
                this.line++;
                this.column = 1;
            } else if (code === 13) {
                if (this.source.charCodeAt(this.pos) !== 10) {
                    this.line++;
                    this.column = 1;
                }
            } else {
                this.column++;
            }
        }
    }

    add(type, value, line, column, extra) {
        const token = { t: type, v: value, line, column };
        if (extra) Object.assign(token, extra);
        this.tokens.push(token);
        return token;
    }

    longBracketEnd(startPos) {
        // startPos points at '['.
        let pos = startPos + 1;
        let level = 0;
        while (this.source.charCodeAt(pos) === 61) {
            level++;
            pos++;
        }
        if (this.source.charCodeAt(pos) !== 91) return null;
        const close = `]${'='.repeat(level)}]`;
        const end = this.source.indexOf(close, pos + 1);
        if (end < 0) return null;
        return { level, contentStart: pos + 1, contentEnd: end, end: end + close.length };
    }

    skipSpaceAndComments() {
        for (;;) {
            const code = this.peekChar();
            if (code === 32 || code === 9 || code === 11 || code === 12 || code === 10 || code === 13) {
                this.advance();
                continue;
            }
            if (code === 45 && this.peekChar(1) === 45) {
                const line = this.line;
                const column = this.column;
                this.advance(2);
                const bracket = this.peekChar() === 91 ? this.longBracketEnd(this.pos) : null;
                if (bracket) {
                    this.advance(bracket.end - this.pos);
                } else {
                    while (this.pos < this.source.length && this.peekChar() !== 10 && this.peekChar() !== 13) {
                        this.advance();
                    }
                }
                void line;
                void column;
                continue;
            }
            return;
        }
    }

    scanLongString() {
        const line = this.line;
        const column = this.column;
        const bracket = this.longBracketEnd(this.pos);
        if (!bracket) this.error('malformed long string');
        const rawStart = bracket.contentStart;
        let rawEnd = bracket.contentEnd;
        // A newline immediately following the opening bracket is skipped.
        if (this.source.charCodeAt(rawStart) === 10) {
            rawEnd = rawEnd; // content still begins after newline
        }
        this.advance(bracket.end - this.pos);
        let start = rawStart;
        if (this.source.charCodeAt(start) === 10) start++;
        else if (this.source.charCodeAt(start) === 13 && this.source.charCodeAt(start + 1) === 10) start += 2;
        else if (this.source.charCodeAt(start) === 13) start++;
        const bytes = [];
        for (let i = start; i < rawEnd;) {
            i += appendLiteralChar(bytes, this.source, i);
        }
        this.add('string', bytesToString(bytes), line, column);
    }

    readEscape(bytes) {
        // Called after the backslash has been consumed.
        const code = this.peekChar();
        if (code < 0) this.error('unfinished string');
        const simple = {
            97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11,
            92: 92, 34: 34, 39: 39, 96: 96
        };
        if (Object.prototype.hasOwnProperty.call(simple, code)) {
            bytes.push(simple[code]);
            this.advance();
            return;
        }
        if (code === 122) { // \z: skip following whitespace
            this.advance();
            for (;;) {
                const c = this.peekChar();
                if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) this.advance();
                else break;
            }
            return;
        }
        if (code === 120) { // \xXX
            this.advance();
            const a = this.peekChar();
            const b = this.peekChar(1);
            if (!isHexDigit(a) || !isHexDigit(b)) this.error('malformed \\x escape');
            bytes.push(hexValue(a) * 16 + hexValue(b));
            this.advance(2);
            return;
        }
        if (code === 117 && this.peekChar(1) === 123) { // \u{XXXX}
            this.advance(2);
            let value = 0;
            let digits = 0;
            while (isHexDigit(this.peekChar())) {
                value = value * 16 + hexValue(this.peekChar());
                this.advance();
                digits++;
                if (digits > 8) this.error('malformed \\u escape');
            }
            if (digits === 0 || this.peekChar() !== 125 || value > 0x10ffff) this.error('malformed \\u escape');
            this.advance();
            appendUtf8(bytes, value);
            return;
        }
        if (isDigit(code)) {
            let value = 0;
            let digits = 0;
            while (isDigit(this.peekChar()) && digits < 3) {
                value = value * 10 + (this.peekChar() - 48);
                this.advance();
                digits++;
            }
            if (value > 255) this.error('decimal escape too large');
            bytes.push(value);
            return;
        }
        if (code === 10 || code === 13) {
            // Escaped physical newline becomes a newline byte.
            if (code === 13 && this.peekChar(1) === 10) this.advance();
            this.advance();
            bytes.push(10);
            return;
        }
        // Unknown escapes are preserved without the backslash. Strict Lua
        // rejects them; being permissive keeps unusual scripts loadable.
        const ch = this.source.codePointAt(this.pos);
        appendUtf8(bytes, ch);
        this.advance(ch > 0xffff ? 2 : 1);
    }

    scanQuotedString(quoteCode) {
        const line = this.line;
        const column = this.column;
        this.advance();
        const bytes = [];
        for (;;) {
            if (this.pos >= this.source.length) this.error('unfinished string', line, column);
            const code = this.peekChar();
            if (code === quoteCode) {
                this.advance();
                break;
            }
            if (code === 10 || code === 13) this.error('unfinished string', line, column);
            if (code === 92) {
                this.advance();
                this.readEscape(bytes);
                continue;
            }
            this.pos += appendLiteralChar(bytes, this.source, this.pos);
            this.column++;
        }
        this.add('string', bytesToString(bytes), line, column);
    }

    scanInterpString() {
        const line = this.line;
        const column = this.column;
        this.advance(); // backtick
        const parts = [];
        let bytes = [];
        const flushText = () => {
            if (bytes.length) {
                parts.push({ kind: 'text', value: bytesToString(bytes) });
                bytes = [];
            }
        };
        for (;;) {
            if (this.pos >= this.source.length) this.error('unfinished interpolated string', line, column);
            const code = this.peekChar();
            if (code === 96) {
                this.advance();
                break;
            }
            if (code === 92) {
                this.advance();
                this.readEscape(bytes);
                continue;
            }
            if (code === 123) { // {
                flushText();
                const exprStart = this.pos + 1;
                const exprLine = this.line;
                const exprColumn = this.column + 1;
                this.advance();
                this.scanInterpExpression();
                const exprEnd = this.pos - 1; // exclusive close brace
                const exprSource = this.source.slice(exprStart, exprEnd);
                const sub = new Tokenizer(exprSource);
                let tokens;
                try {
                    tokens = sub.tokenize();
                } catch (error) {
                    if (error instanceof LuaVmError) {
                        throw new LuaVmError(error.message.replace(/ \(line \d+\)$/, ''), exprLine + error.line - 1, exprColumn);
                    }
                    throw error;
                }
                for (const token of tokens) {
                    if (token.t !== 'eof') {
                        token.line += exprLine - 1;
                        token.column += token.line === exprLine ? exprColumn - 1 : 0;
                    }
                }
                parts.push({ kind: 'expr', tokens });
                continue;
            }
            this.pos += appendLiteralChar(bytes, this.source, this.pos);
            this.column++;
        }
        flushText();
        this.add('interp', parts, line, column);
    }

    scanInterpExpression() {
        // Cursor is just after the opening '{'. Consumes the matching '}'.
        let depth = 1;
        while (this.pos < this.source.length) {
            const code = this.peekChar();
            if (code === 123) { // {
                depth++;
                this.advance();
                continue;
            }
            if (code === 125) { // }
                depth--;
                this.advance();
                if (depth === 0) return;
                continue;
            }
            if (code === 34 || code === 39) {
                this.skipQuotedForInterp(code);
                continue;
            }
            if (code === 96) {
                this.skipBacktickForInterp();
                continue;
            }
            if (code === 91 && this.peekChar(1) === 91) {
                const bracket = this.longBracketEnd(this.pos);
                if (bracket) {
                    this.advance(bracket.end - this.pos);
                    continue;
                }
            }
            if (code === 45 && this.peekChar(1) === 45) {
                this.advance(2);
                const bracket = this.peekChar() === 91 ? this.longBracketEnd(this.pos) : null;
                if (bracket) this.advance(bracket.end - this.pos);
                else {
                    while (this.pos < this.source.length && this.peekChar() !== 10 && this.peekChar() !== 13) this.advance();
                }
                continue;
            }
            this.advance();
        }
        this.error('unfinished interpolated expression');
    }

    skipQuotedForInterp(quoteCode) {
        this.advance();
        while (this.pos < this.source.length) {
            const code = this.peekChar();
            if (code === quoteCode) { this.advance(); return; }
            if (code === 92) { this.advance(2); continue; }
            this.advance();
        }
        this.error('unfinished string in interpolated expression');
    }

    skipBacktickForInterp() {
        this.advance();
        while (this.pos < this.source.length) {
            const code = this.peekChar();
            if (code === 96) { this.advance(); return; }
            if (code === 92) { this.advance(2); continue; }
            if (code === 123) {
                this.advance();
                this.scanInterpExpression();
                continue;
            }
            this.advance();
        }
        this.error('unfinished interpolated string');
    }

    scanNumber() {
        const line = this.line;
        const column = this.column;
        const start = this.pos;
        let value;
        if (this.peekChar() === 48 && (this.peekChar(1) === 120 || this.peekChar(1) === 88)) {
            this.advance(2);
            let text = '';
            let digits = 0;
            while (isHexDigit(this.peekChar()) || this.peekChar() === 95) {
                const c = this.peekChar();
                if (c !== 95) text += String.fromCharCode(c);
                this.advance();
                digits++;
            }
            if (digits === 0) this.error('malformed number', line, column);
            value = parseInt(text, 16);
        } else if (this.peekChar() === 48 && (this.peekChar(1) === 98 || this.peekChar(1) === 66)) {
            this.advance(2);
            let text = '';
            let digits = 0;
            while (this.peekChar() === 48 || this.peekChar() === 49 || this.peekChar() === 95) {
                const c = this.peekChar();
                if (c !== 95) text += String.fromCharCode(c);
                this.advance();
                digits++;
            }
            if (digits === 0) this.error('malformed number', line, column);
            value = parseInt(text, 2);
        } else {
            let text = '';
            while (isDigit(this.peekChar()) || this.peekChar() === 95) {
                const c = this.peekChar();
                if (c !== 95) text += String.fromCharCode(c);
                this.advance();
            }
            if (this.peekChar() === 46 && this.peekChar(1) !== 46) {
                text += '.';
                this.advance();
                while (isDigit(this.peekChar()) || this.peekChar() === 95) {
                    const c = this.peekChar();
                    if (c !== 95) text += String.fromCharCode(c);
                    this.advance();
                }
            }
            if (this.peekChar() === 101 || this.peekChar() === 69) {
                text += 'e';
                this.advance();
                if (this.peekChar() === 43 || this.peekChar() === 45) {
                    text += String.fromCharCode(this.peekChar());
                    this.advance();
                }
                let expDigits = 0;
                while (isDigit(this.peekChar()) || this.peekChar() === 95) {
                    const c = this.peekChar();
                    if (c !== 95) { text += String.fromCharCode(c); expDigits++; }
                    this.advance();
                }
                if (expDigits === 0) this.error('malformed number', line, column);
            }
            value = Number(text);
        }
        if (this.pos === start) this.error('malformed number', line, column);
        if (isNameStart(this.peekChar())) this.error('malformed number', line, column);
        this.add('number', value, line, column);
    }

    tokenize() {
        for (;;) {
            this.skipSpaceAndComments();
            if (this.pos >= this.source.length) break;
            const code = this.peekChar();
            const line = this.line;
            const column = this.column;
            if (isNameStart(code)) {
                const start = this.pos;
                while (isNamePart(this.peekChar())) this.advance();
                const word = this.source.slice(start, this.pos);
                this.add(KEYWORDS.has(word) ? 'kw' : 'name', word, line, column);
                continue;
            }
            if (isDigit(code) || (code === 46 && isDigit(this.peekChar(1)))) {
                this.scanNumber();
                continue;
            }
            if (code === 34 || code === 39) {
                this.scanQuotedString(code);
                continue;
            }
            if (code === 96) {
                this.scanInterpString();
                continue;
            }
            if (code === 91 && this.peekChar(1) === 91 ||
                code === 91 && this.peekChar(1) === 61) {
                const bracket = this.longBracketEnd(this.pos);
                if (bracket) {
                    this.scanLongString();
                    continue;
                }
            }
            let matched = false;
            for (const op of MULTI_OPS) {
                if (this.source.startsWith(op, this.pos)) {
                    this.advance(op.length);
                    this.add('op', op, line, column);
                    matched = true;
                    break;
                }
            }
            if (matched) continue;
            const ch = String.fromCharCode(code);
            if (SINGLE_OPS.has(ch)) {
                this.advance();
                this.add('op', ch, line, column);
                continue;
            }
            this.error(`unexpected character ${JSON.stringify(ch)}`, line, column);
        }
        this.add('eof', '<eof>', this.line, this.column);
        return this.tokens;
    }
}

class Parser {
    constructor(tokens, source = '') {
        this.tokens = tokens;
        this.source = source;
        this.pos = 0;
    }

    peek(offset = 0) {
        const index = this.pos + offset;
        return index < this.tokens.length ? this.tokens[index] : this.tokens[this.tokens.length - 1];
    }

    next() {
        const token = this.tokens[this.pos];
        if (this.pos < this.tokens.length - 1) this.pos++;
        return token;
    }

    check(type, value) {
        const token = this.peek();
        return token.t === type && (value === undefined || token.v === value);
    }

    checkOp(value) {
        return this.check('op', value);
    }

    checkKw(value) {
        return this.check('kw', value);
    }

    accept(type, value) {
        if (this.check(type, value)) {
            return this.next();
        }
        return null;
    }

    acceptOp(value) {
        if (this.checkOp(value)) {
            return this.next();
        }
        return null;
    }

    acceptKw(value) {
        if (this.checkKw(value)) {
            return this.next();
        }
        return null;
    }

    expect(type, value) {
        const token = this.peek();
        if (token.t !== type || (value !== undefined && token.v !== value)) {
            const found = token.t === 'eof' ? 'end of file' : `'${token.v}'`;
            const wanted = value !== undefined ? `'${value}'` : type;
            throw new LuaVmError(`expected ${wanted} but found ${found}`, token.line, token.column);
        }
        return this.next();
    }

    expectName() {
        return this.expect('name');
    }

    expectOp(value) {
        return this.expect('op', value);
    }

    expectKw(value) {
        return this.expect('kw', value);
    }

    error(message, token = this.peek()) {
        throw new LuaVmError(message, token.line, token.column);
    }

    isBlockEnd(token = this.peek()) {
        return token.t === 'eof' ||
            (token.t === 'kw' && (token.v === 'end' || token.v === 'else' || token.v === 'elseif' || token.v === 'until'));
    }

    parseChunk() {
        const body = this.parseBlock();
        if (!this.check('eof')) this.error(`unexpected '${this.peek().v}'`);
        return { k: 'chunk', body };
    }

    parseBlock() {
        const body = [];
        while (!this.isBlockEnd()) {
            if (this.acceptOp(';')) continue;
            body.push(this.parseStatement());
            while (this.acceptOp(';')) { /* empty statements */ }
        }
        return body;
    }

    parseStatement() {
        const token = this.peek();
        if (token.t === 'kw') {
            switch (token.v) {
                case 'local': return this.parseLocal();
                case 'function': return this.parseFunctionDeclaration();
                case 'if': return this.parseIfStatement();
                case 'while': return this.parseWhile();
                case 'repeat': return this.parseRepeat();
                case 'for': return this.parseFor();
                case 'do': return this.parseDo();
                case 'return': return this.parseReturn();
                case 'break': this.next(); return { k: 'break', line: token.line };
                default: break;
            }
        }
        if (token.t === 'name' && token.v === 'continue') {
            const nextToken = this.peek(1);
            const expressionLike = nextToken.t === 'op' &&
                ['(', '[', '.', ':', '=', ',', '"', '::'].includes(nextToken.v) ||
                (nextToken.t === 'op' && ['+=', '-=', '*=', '/=', '%=', '^=', '..='].includes(nextToken.v)) ||
                nextToken.t === 'string' || nextToken.t === 'interp' ||
                (nextToken.t === 'op' && nextToken.v === '{');
            if (!expressionLike) {
                this.next();
                return { k: 'continue', line: token.line };
            }
        }
        // Some Luau obfuscators emit `const function name(...)` as a local function.
        if (token.t === 'name' && token.v === 'const' && this.peek(1).t === 'kw' && this.peek(1).v === 'function' &&
            this.peek(2).t === 'name') {
            this.next();
            this.next();
            const name = this.expectName();
            const func = this.parseFunctionBody(false);
            return { k: 'localfunction', name: name.v, func, line: token.line };
        }
        // Some Luau obfuscators emit `const x = ...` as a local declaration.
        if (token.t === 'name' && token.v === 'const' && this.peek(1).t === 'name' &&
            this.peek(2).t === 'op' && (this.peek(2).v === '=' || this.peek(2).v === ',' || this.peek(2).v === ':')) {
            this.next();
            const names = [];
            for (;;) {
                const nameToken = this.expectName();
                const name = { name: nameToken.v, attrib: null };
                if (this.acceptOp(':')) this.parseType();
                names.push(name);
                if (!this.acceptOp(',')) break;
            }
            let values = [];
            if (this.acceptOp('=')) values = this.parseExpressionList();
            return { k: 'local', names, values, line: token.line };
        }
        if (token.t === 'name' && token.v === 'type' && this.peek(1).t === 'name' &&
            (this.peek(2).t === 'op' && (this.peek(2).v === '=' || this.peek(2).v === '<'))) {
            return this.parseTypeAlias(false);
        }
        if (token.t === 'name' && token.v === 'export' && this.peek(1).t === 'name' && this.peek(1).v === 'type' &&
            this.peek(2).t === 'name') {
            this.next();
            return this.parseTypeAlias(true);
        }
        if (token.t === 'name' && token.v === 'declare') {
            return this.parseDeclare();
        }
        if (token.t === 'op' && token.v === '@') {
            this.next();
            if (this.peek().t === 'name') this.next();
            return { k: 'noop', line: token.line };
        }
        return this.parseAssignmentOrCall();
    }

    parseTypeAlias(exported) {
        const start = this.peek();
        if (exported) this.expect('name', 'type');
        else this.next();
        this.expectName();
        this.skipTypeParams();
        this.expectOp('=');
        this.parseType();
        return { k: 'noop', line: start.line };
    }

    parseDeclare() {
        const start = this.next();
        const line = start.line;
        let depth = 0;
        while (!this.check('eof')) {
            const token = this.peek();
            if (token.line > line && depth === 0 && token.t !== 'op') break;
            if (token.t === 'op') {
                if (['(', '{', '['].includes(token.v)) depth++;
                else if ([')', '}', ']'].includes(token.v)) depth = Math.max(0, depth - 1);
            }
            this.next();
        }
        return { k: 'noop', line };
    }

    parseLocal() {
        const start = this.next();
        if (this.checkKw('function')) {
            this.next();
            const name = this.expectName();
            const func = this.parseFunctionBody(false);
            return { k: 'localfunction', name: name.v, func, line: start.line };
        }
        const names = [];
        for (;;) {
            const nameToken = this.expectName();
            const name = { name: nameToken.v, attrib: null };
            if (this.checkOp('<') && this.peek(1).t === 'name' &&
                (this.peek(1).v === 'const' || this.peek(1).v === 'close')) {
                this.next();
                name.attrib = this.next().v;
                this.expectOp('>');
            }
            if (this.acceptOp(':')) this.parseType();
            names.push(name);
            if (!this.acceptOp(',')) break;
        }
        let values = [];
        if (this.acceptOp('=')) values = this.parseExpressionList();
        return { k: 'local', names, values, line: start.line };
    }

    parseFunctionDeclaration() {
        const start = this.next();
        let target = { k: 'name', name: this.expectName().v, line: start.line };
        let isMethod = false;
        while (this.acceptOp('.')) {
            const name = this.expectName();
            target = {
                k: 'index',
                obj: target,
                key: { k: 'string', value: name.v, line: name.line },
                line: name.line
            };
        }
        if (this.acceptOp(':')) {
            const name = this.expectName();
            target = {
                k: 'index',
                obj: target,
                key: { k: 'string', value: name.v, line: name.line },
                line: name.line
            };
            isMethod = true;
        }
        const func = this.parseFunctionBody(isMethod);
        return { k: 'funcdecl', target, func, line: start.line };
    }

    skipTypeParams() {
        if (!this.checkOp('<')) return;
        let depth = 0;
        do {
            const token = this.next();
            if (token.t === 'eof') this.error('unfinished type parameter list', token);
            if (token.t === 'op') {
                if (token.v === '<') depth += 1;
                else if (token.v === '>') depth -= 1;
                else if (token.v === '>>') depth -= 2;
                else if (token.v === '<<') depth += 2;
            }
            if (depth < 0) depth = 0;
        } while (depth > 0);
    }

    parseFunctionBody(isMethod) {
        const start = this.peek();
        this.skipTypeParams();
        this.expectOp('(');
        const params = [];
        let isVararg = false;
        if (!this.checkOp(')')) {
            for (;;) {
                if (this.checkOp('...')) {
                    this.next();
                    isVararg = true;
                    if (this.acceptOp(':')) this.parseType();
                    break;
                }
                const name = this.expectName();
                params.push(name.v);
                if (this.acceptOp(':')) this.parseType();
                if (!this.acceptOp(',')) break;
            }
        }
        this.expectOp(')');
        if (this.acceptOp(':')) this.parseType();
        const body = this.parseBlock();
        this.expectKw('end');
        return {
            k: 'function',
            params,
            isVararg,
            isMethod: isMethod === true,
            body,
            line: start.line
        };
    }

    parseIfStatement() {
        const start = this.next();
        const clauses = [];
        const cond = this.parseExpression();
        this.expectKw('then');
        clauses.push({ cond, body: this.parseBlock() });
        while (this.checkKw('elseif')) {
            this.next();
            const elseifCond = this.parseExpression();
            this.expectKw('then');
            clauses.push({ cond: elseifCond, body: this.parseBlock() });
        }
        let elseBody = null;
        if (this.acceptKw('else')) elseBody = this.parseBlock();
        this.expectKw('end');
        return { k: 'if', clauses, elseBody, line: start.line };
    }

    parseWhile() {
        const start = this.next();
        const cond = this.parseExpression();
        this.expectKw('do');
        const body = this.parseBlock();
        this.expectKw('end');
        return { k: 'while', cond, body, line: start.line };
    }

    parseRepeat() {
        const start = this.next();
        const body = this.parseBlock();
        this.expectKw('until');
        const cond = this.parseExpression();
        return { k: 'repeat', body, cond, line: start.line };
    }

    parseDo() {
        const start = this.next();
        const body = this.parseBlock();
        this.expectKw('end');
        return { k: 'do', body, line: start.line };
    }

    parseReturn() {
        const start = this.next();
        const values = this.isBlockEnd() || this.checkOp(';') ? [] : this.parseExpressionList();
        return { k: 'return', values, line: start.line };
    }

    parseFor() {
        const start = this.next();
        const first = this.expectName();
        let nameType = null;
        if (this.acceptOp(':')) nameType = this.parseType();
        if (this.acceptOp('=')) {
            const init = this.parseExpression();
            this.expectOp(',');
            const limit = this.parseExpression();
            let step = null;
            if (this.acceptOp(',')) step = this.parseExpression();
            this.expectKw('do');
            const body = this.parseBlock();
            this.expectKw('end');
            void nameType;
            return { k: 'fornum', name: first.v, init, limit, step, body, line: start.line };
        }
        const names = [first.v];
        if (this.acceptOp(',')) {
            for (;;) {
                names.push(this.expectName().v);
                if (this.acceptOp(':')) this.parseType();
                if (!this.acceptOp(',')) break;
            }
        }
        this.expectKw('in');
        const exprs = this.parseExpressionList();
        this.expectKw('do');
        const body = this.parseBlock();
        this.expectKw('end');
        return { k: 'forin', names, exprs, body, line: start.line };
    }

    parseAssignmentOrCall() {
        const start = this.peek();
        const first = this.parseSuffixed();
        const checkTarget = target => {
            if (target.k !== 'name' && target.k !== 'index') {
                this.error('syntax error: assignment target must be a variable or field', start);
            }
        };
        if (this.checkOp(',')) {
            const targets = [first];
            while (this.acceptOp(',')) targets.push(this.parseSuffixed());
            this.expectOp('=');
            targets.forEach(checkTarget);
            return { k: 'assign', targets, values: this.parseExpressionList(), line: start.line };
        }
        if (this.checkOp('=')) {
            this.next();
            checkTarget(first);
            return { k: 'assign', targets: [first], values: this.parseExpressionList(), line: start.line };
        }
        if (this.isCompoundOp()) {
            const op = this.next();
            checkTarget(first);
            return { k: 'compound', target: first, op: op.v.slice(0, -1), value: this.parseExpression(), line: start.line };
        }
        if (first.k === 'call' || first.k === 'method') {
            return { k: 'callstat', call: first, line: start.line };
        }
        this.error('syntax error: expected assignment or function call', start);
    }

    isCompoundOp() {
        return this.peek().t === 'op' &&
            ['+=', '-=', '*=', '/=', '%=', '^=', '..=', '//=', '>>=', '<<='].includes(this.peek().v);
    }

    parseExpressionList() {
        const values = [this.parseExpression()];
        while (this.acceptOp(',')) values.push(this.parseExpression());
        return values;
    }

    parseExpression(minBp = 0) {
        let left = this.parseUnary();
        for (;;) {
            const token = this.peek();
            let op = null;
            if (token.t === 'op' || (token.t === 'kw' && (token.v === 'and' || token.v === 'or'))) op = token.v;
            if (!op || !Object.prototype.hasOwnProperty.call(BINARY_BP, op)) break;
            const binding = BINARY_BP[op];
            if (binding[0] < minBp) break;
            this.next();
            const right = this.parseExpression(binding[1]);
            left = { k: 'bin', op, left, right, line: token.line };
        }
        return left;
    }

    parseUnary() {
        const token = this.peek();
        const isUnary = (token.t === 'kw' && token.v === 'not') ||
            (token.t === 'op' && (token.v === '-' || token.v === '#' || token.v === '~'));
        if (isUnary) {
            this.next();
            const expr = this.parseExpression(UNARY_BP);
            return { k: 'un', op: token.v, expr, line: token.line };
        }
        return this.parseSuffixed();
    }

    parseSuffixed() {
        let expr = this.parsePrimary();
        for (;;) {
            const token = this.peek();
            if (token.t === 'op') {
                if (token.v === '.') {
                    this.next();
                    const name = this.expectName();
                    expr = {
                        k: 'index',
                        obj: expr,
                        key: { k: 'string', value: name.v, line: name.line },
                        line: name.line
                    };
                    continue;
                }
                if (token.v === '[') {
                    this.next();
                    const key = this.parseExpression();
                    this.expectOp(']');
                    expr = { k: 'index', obj: expr, key, line: token.line };
                    continue;
                }
                if (token.v === ':') {
                    this.next();
                    const name = this.expectName();
                    const args = this.parseCallArguments();
                    expr = { k: 'method', obj: expr, name: name.v, args, line: token.line };
                    continue;
                }
                if (token.v === '(') {
                    const args = this.parseCallArguments();
                    expr = { k: 'call', fn: expr, args, line: token.line };
                    continue;
                }
                if (token.v === '::') {
                    this.next();
                    this.parseType();
                    continue;
                }
                if (token.v === '{') {
                    const args = this.parseCallArguments();
                    expr = { k: 'call', fn: expr, args, line: token.line };
                    continue;
                }
            }
            if (token.t === 'string' || token.t === 'interp') {
                const args = this.parseCallArguments();
                expr = { k: 'call', fn: expr, args, line: token.line };
                continue;
            }
            break;
        }
        return expr;
    }

    parseCallArguments() {
        const token = this.peek();
        if (token.t === 'op' && token.v === '(') {
            this.next();
            const args = [];
            if (!this.checkOp(')')) args.push(...this.parseExpressionList());
            this.expectOp(')');
            return args;
        }
        if (token.t === 'string') {
            this.next();
            return [{ k: 'string', value: token.v, line: token.line }];
        }
        if (token.t === 'interp') {
            this.next();
            return [this.parseInterpToken(token)];
        }
        if (token.t === 'op' && token.v === '{') {
            return [this.parseTable()];
        }
        this.error('function arguments expected', token);
    }

    parsePrimary() {
        const token = this.peek();
        if (token.t === 'number') {
            this.next();
            return { k: 'number', value: token.v, line: token.line };
        }
        if (token.t === 'string') {
            this.next();
            return { k: 'string', value: token.v, line: token.line };
        }
        if (token.t === 'interp') {
            this.next();
            return this.parseInterpToken(token);
        }
        if (token.t === 'kw') {
            if (token.v === 'nil') { this.next(); return { k: 'nil', line: token.line }; }
            if (token.v === 'true') { this.next(); return { k: 'true', line: token.line }; }
            if (token.v === 'false') { this.next(); return { k: 'false', line: token.line }; }
            if (token.v === 'function') {
                this.next();
                return this.parseFunctionBody(false);
            }
            if (token.v === 'if') return this.parseIfExpression();
        }
        if (token.t === 'op') {
            if (token.v === '...') {
                this.next();
                return { k: 'vararg', line: token.line };
            }
            if (token.v === '{') return this.parseTable();
            if (token.v === '(') {
                this.next();
                const expr = this.parseExpression();
                this.expectOp(')');
                return { k: 'paren', expr, line: token.line };
            }
        }
        if (token.t === 'name') {
            this.next();
            return { k: 'name', name: token.v, line: token.line };
        }
        this.error(`unexpected token '${token.v}'`, token);
    }

    parseIfExpression() {
        const start = this.expectKw('if');
        const clauses = [];
        const cond = this.parseExpression();
        this.expectKw('then');
        const value = this.parseExpression();
        clauses.push({ cond, value });
        while (this.checkKw('elseif')) {
            this.next();
            const elseifCond = this.parseExpression();
            this.expectKw('then');
            const elseifValue = this.parseExpression();
            clauses.push({ cond: elseifCond, value: elseifValue });
        }
        this.expectKw('else');
        const elseValue = this.parseExpression();
        return { k: 'ifexpr', clauses, elseValue, line: start.line };
    }

    parseTable() {
        const start = this.expectOp('{');
        const fields = [];
        while (!this.checkOp('}')) {
            if (this.checkOp('[')) {
                this.next();
                const key = this.parseExpression();
                this.expectOp(']');
                this.expectOp('=');
                const value = this.parseExpression();
                fields.push({ kind: 'keyed', key, value });
            } else if (this.peek().t === 'name' && this.peek(1).t === 'op' && this.peek(1).v === '=') {
                const name = this.next();
                this.next();
                const value = this.parseExpression();
                fields.push({ kind: 'named', name: name.v, value });
            } else {
                const value = this.parseExpression();
                fields.push({ kind: 'array', value });
            }
            if (!this.acceptOp(',') && !this.acceptOp(';')) break;
        }
        this.expectOp('}');
        return { k: 'table', fields, line: start.line };
    }

    parseInterpToken(token) {
        const parts = [];
        for (const part of token.v) {
            if (part.kind === 'text') {
                parts.push({ kind: 'text', value: part.value });
                continue;
            }
            const sub = new Parser(part.tokens, this.source);
            const expr = sub.parseExpression();
            if (!sub.check('eof')) sub.error('unexpected token in interpolated expression');
            parts.push({ kind: 'expr', value: expr });
        }
        return { k: 'interp', parts, line: token.line };
    }

    parseType() {
        this.parseTypeUnion();
    }

    parseTypeUnion() {
        this.parseTypeIntersection();
        while (this.acceptOp('|')) this.parseTypeIntersection();
    }

    parseTypeIntersection() {
        this.parseTypeSuffix();
        while (this.acceptOp('&')) this.parseTypeSuffix();
    }

    parseTypeSuffix() {
        this.parseTypePrimary();
        while (this.acceptOp('?')) { /* optional suffix */ }
    }

    parseTypePrimary() {
        const token = this.peek();
        if (token.t === 'string' || token.t === 'number') {
            this.next();
            return;
        }
        if (token.t === 'kw' && (token.v === 'nil' || token.v === 'true' || token.v === 'false')) {
            this.next();
            return;
        }
        if (token.t === 'op' && token.v === '...') {
            this.next();
            if (!this.checkTypeStop()) this.parseTypeUnion();
            return;
        }
        if (token.t === 'name') {
            if (token.v === 'typeof' && this.peek(1).t === 'op' && this.peek(1).v === '(') {
                this.next();
                this.expectOp('(');
                this.parseExpression();
                this.expectOp(')');
                return;
            }
            this.next();
            while (this.acceptOp('.')) this.expectName();
            if (this.checkOp('<')) this.parseTypeArguments();
            return;
        }
        if (token.t === 'op' && token.v === '{') {
            this.parseTableType();
            return;
        }
        if (token.t === 'op' && token.v === '(') {
            this.next();
            if (!this.checkOp(')')) {
                this.parseTypeUnion();
                while (this.acceptOp(',')) {
                    if (this.checkOp(')')) break;
                    this.parseTypeUnion();
                }
            }
            this.expectOp(')');
            if (this.acceptOp('->')) this.parseTypeUnion();
            return;
        }
        if (token.t === 'kw' && token.v === 'function') {
            // Luau has no function type keyword, but typeof-like forms exist.
            this.next();
            return;
        }
        this.error(`unexpected token '${token.v}' in type`, token);
    }

    parseTypeArguments() {
        this.expectOp('<');
        if (!this.checkOp('>')) {
            for (;;) {
                if (this.checkOp('>>')) {
                    // Close this generic list and leave one '>' for the outer list.
                    const token = this.peek();
                    this.tokens[this.pos] = { t: 'op', v: '>', line: token.line, column: token.column + 1 };
                    return;
                }
                this.parseTypeUnion();
                if (!this.acceptOp(',')) break;
            }
        }
        if (this.checkOp('>>')) {
            const token = this.peek();
            this.tokens[this.pos] = { t: 'op', v: '>', line: token.line, column: token.column + 1 };
            return;
        }
        this.expectOp('>');
    }

    parseTableType() {
        this.expectOp('{');
        if (this.acceptOp('|')) {
            // Exact table type: {| ... |}
            while (!this.checkOp('|')) {
                this.parseTableTypeField();
                if (!this.acceptOp(',') && !this.acceptOp(';')) break;
            }
            this.expectOp('|');
            this.expectOp('}');
            return;
        }
        while (!this.checkOp('}')) {
            this.parseTableTypeField();
            if (!this.acceptOp(',') && !this.acceptOp(';')) break;
        }
        this.expectOp('}');
    }

    parseTableTypeField() {
        if (this.acceptOp('[')) {
            this.parseTypeUnion();
            this.expectOp(']');
            this.expectOp(':');
            this.parseTypeUnion();
            return;
        }
        if (this.peek().t === 'name' && this.peek(1).t === 'op' && this.peek(1).v === ':') {
            this.next();
            this.next();
            this.parseTypeUnion();
            return;
        }
        if (this.peek().t === 'name' && (this.peek().v === 'read' || this.peek().v === 'write') &&
            this.peek(1).t === 'name') {
            this.next();
        }
        if (this.peek().t === 'name' && this.peek(1).t === 'op' && this.peek(1).v === ':') {
            this.next();
            this.next();
            this.parseTypeUnion();
            return;
        }
        this.parseTypeUnion();
    }

    checkTypeStop() {
        const token = this.peek();
        return this.isBlockEnd(token) || token.t === 'eof' ||
            (token.t === 'op' && [',', ')', ']', '}', '=', '->', ';'].includes(token.v));
    }
}

class Scope {
    constructor(parent = null) {
        this.parent = parent;
        this.names = new Set();
    }

    has(name) {
        let scope = this;
        while (scope) {
            if (scope.names.has(name)) return true;
            scope = scope.parent;
        }
        return false;
    }
}

function analyzeChunk(chunk) {
    const info = { free: new Set(), boxed: new Set() };
    const state = {
        free: info.free,
        descendant: info.boxed,
        scope: new Scope()
    };
    walkStatements(chunk.body, state);
    return info;
}

function analyzeFunction(fn) {
    if (fn._analysis) return fn._analysis;
    const free = new Set();
    const descendant = new Set();
    const scope = new Scope();
    for (const param of fn.params) scope.names.add(param);
    if (fn.isMethod) scope.names.add('self');
    const state = { free, descendant, scope };
    walkStatements(fn.body, state);
    const info = { free, boxed: descendant };
    fn._analysis = info;
    fn.freeNames = free;
    fn.boxedNames = descendant;
    return info;
}

function useName(name, state) {
    if (!state.scope.has(name)) state.free.add(name);
}

function useFunction(fn, state) {
    const info = analyzeFunction(fn);
    for (const name of info.free) {
        state.descendant.add(name);
        if (!state.scope.has(name)) state.free.add(name);
    }
}

function walkStatements(body, state) {
    for (const statement of body) walkStatement(statement, state);
}

function walkFunctionExpression(fn, state) {
    useFunction(fn, state);
}

function walkExpression(expr, state) {
    if (!expr) return;
    switch (expr.k) {
        case 'name':
            useName(expr.name, state);
            break;
        case 'number': case 'string': case 'nil': case 'true': case 'false': case 'vararg':
            break;
        case 'paren':
            walkExpression(expr.expr, state);
            break;
        case 'un':
            walkExpression(expr.expr, state);
            break;
        case 'bin':
            walkExpression(expr.left, state);
            walkExpression(expr.right, state);
            break;
        case 'index':
            walkExpression(expr.obj, state);
            walkExpression(expr.key, state);
            break;
        case 'call':
            walkExpression(expr.fn, state);
            for (const arg of expr.args) walkExpression(arg, state);
            break;
        case 'method':
            walkExpression(expr.obj, state);
            for (const arg of expr.args) walkExpression(arg, state);
            break;
        case 'table':
            for (const field of expr.fields) {
                if (field.kind === 'keyed') walkExpression(field.key, state);
                walkExpression(field.value, state);
            }
            break;
        case 'function':
            walkFunctionExpression(expr, state);
            break;
        case 'ifexpr':
            for (const clause of expr.clauses) {
                walkExpression(clause.cond, state);
                walkExpression(clause.value, state);
            }
            walkExpression(expr.elseValue, state);
            break;
        case 'interp':
            for (const part of expr.parts) {
                if (part.kind === 'expr') walkExpression(part.value, state);
            }
            break;
        default:
            break;
    }
}

function walkExpressionList(list, state) {
    for (const expr of list) walkExpression(expr, state);
}

function walkStatement(statement, state) {
    switch (statement.k) {
        case 'noop':
        case 'break':
        case 'continue':
            break;
        case 'local': {
            walkExpressionList(statement.values, state);
            for (const name of statement.names) state.scope.names.add(name.name);
            break;
        }
        case 'localfunction': {
            state.scope.names.add(statement.name);
            walkFunctionExpression(statement.func, state);
            break;
        }
        case 'funcdecl': {
            walkExpression(statement.target, state);
            walkFunctionExpression(statement.func, state);
            break;
        }
        case 'assign':
            for (const target of statement.targets) walkExpression(target, state);
            walkExpressionList(statement.values, state);
            break;
        case 'compound':
            walkExpression(statement.target, state);
            walkExpression(statement.value, state);
            break;
        case 'callstat':
            walkExpression(statement.call, state);
            break;
        case 'do': {
            const previous = state.scope;
            state.scope = new Scope(previous);
            walkStatements(statement.body, state);
            state.scope = previous;
            break;
        }
        case 'while': {
            walkExpression(statement.cond, state);
            const previous = state.scope;
            state.scope = new Scope(previous);
            walkStatements(statement.body, state);
            state.scope = previous;
            break;
        }
        case 'repeat': {
            const previous = state.scope;
            state.scope = new Scope(previous);
            walkStatements(statement.body, state);
            walkExpression(statement.cond, state);
            state.scope = previous;
            break;
        }
        case 'if':
            for (const clause of statement.clauses) {
                walkExpression(clause.cond, state);
                const previous = state.scope;
                state.scope = new Scope(previous);
                walkStatements(clause.body, state);
                state.scope = previous;
            }
            if (statement.elseBody) {
                const previous = state.scope;
                state.scope = new Scope(previous);
                walkStatements(statement.elseBody, state);
                state.scope = previous;
            }
            break;
        case 'fornum': {
            walkExpression(statement.init, state);
            walkExpression(statement.limit, state);
            if (statement.step) walkExpression(statement.step, state);
            const previous = state.scope;
            state.scope = new Scope(previous);
            state.scope.names.add(statement.name);
            walkStatements(statement.body, state);
            state.scope = previous;
            break;
        }
        case 'forin': {
            walkExpressionList(statement.exprs, state);
            const previous = state.scope;
            state.scope = new Scope(previous);
            for (const name of statement.names) state.scope.names.add(name);
            walkStatements(statement.body, state);
            state.scope = previous;
            break;
        }
        case 'return':
            walkExpressionList(statement.values, state);
            break;
        default:
            break;
    }
}

export { Tokenizer, Parser };

export function parseLua(source) {
    const tokenizer = new Tokenizer(source);
    const tokens = tokenizer.tokenize();
    const parser = new Parser(tokens, source);
    const chunk = parser.parseChunk();
    const analysis = analyzeChunk(chunk);
    chunk.freeNames = analysis.free;
    chunk.boxedNames = analysis.boxed;
    return chunk;
}
