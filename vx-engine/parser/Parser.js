import { parseType, parseReturnType, parseGenericTypeListWithDefaults } from "./TypeParser.js";
const BINARY_PRECEDENCE = {
    "or": 1,
    "and": 2,
    "<": 3, ">": 3, "<=": 3, ">=": 3, "~=": 3, "==": 3,
    "..": 4,
    "+": 5, "-": 5,
    "*": 6, "/": 6, "//": 6, "%": 6,
    "^": 7,
};
const BLOCK_END_KEYWORDS = new Set(["end", "else", "elseif", "until"]);
const COMPOUND_OPS = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "^=", "..="]);
export class Parser {
    tokens;
    pos = 0;
    errors = [];
    constructor(tokens) {
        const eof = tokens.find((t) => t.type === "EOF");
        this.tokens = tokens.filter((t) => t.type !== "EOF");
        if (eof)
            this.tokens.push(eof);
    }
    parse() {
        const body = [];
        const start = this.loc();
        while (!this.isEOF()) {
            const stmt = this.parseStatementOrLast();
            if (stmt)
                body.push(stmt);
        }
        return {
            type: "Chunk",
            body,
            loc: { start: start.start, end: this.loc().end },
        };
    }
    getErrors() {
        return this.errors;
    }
    loc() {
        const t = this.tokens[this.pos];
        return t ? t.loc : this.tokens[this.tokens.length - 1].loc;
    }
    peek() {
        return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
    }
    isEOF() {
        return this.peek().type === "EOF";
    }
    consume() {
        return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1];
    }
    check(type, value) {
        const t = this.peek();
        if (t.type !== type)
            return false;
        if (value !== undefined && t.value !== value)
            return false;
        return true;
    }
    expect(type, value) {
        const t = this.peek();
        if (t.type !== type || (value !== undefined && "value" in t && t.value !== value)) {
            this.errors.push({
                message: `Expected ${value ?? type}, got ${"value" in t ? t.value : t.type}`,
                loc: t.loc,
            });
            return null;
        }
        return this.consume();
    }
    createTypeContext() {
        const self = this;
        return {
            tokens: this.tokens,
            get pos() { return self.pos; },
            set pos(v) { self.pos = v; },
            parseExpression: () => this.parseExpression(),
            loc: () => this.loc(),
            mergeLoc: (loc) => this.mergeLoc(loc),
        };
    }
    parseTypeInContext() {
        const ctx = this.createTypeContext();
        const result = parseType(ctx);
        return result;
    }
    parseReturnTypeInContext() {
        const ctx = this.createTypeContext();
        const result = parseReturnType(ctx);
        return result;
    }
    parseGenericTypeListWithDefaultsInContext() {
        const ctx = this.createTypeContext();
        const result = parseGenericTypeListWithDefaults(ctx);
        return result;
    }
    parseStatementOrLast() {
        if (this.check("Keyword", "return"))
            return this.parseReturn();
        if (this.check("Keyword", "break"))
            return this.parseBreak();
        if (this.check("Identifier", "continue") && this.isContinueStatement())
            return this.parseContinue();
        if (this.check("Keyword", "local"))
            return this.parseLocalOrLocalFunction();
        if (this.check("Keyword", "do"))
            return this.parseDo();
        if (this.check("Keyword", "while"))
            return this.parseWhile();
        if (this.check("Keyword", "repeat"))
            return this.parseRepeat();
        if (this.check("Keyword", "if"))
            return this.parseIf();
        if (this.check("Keyword", "for"))
            return this.parseFor();
        if (this.check("Punctuator", "@")) {
            const start = this.loc();
            const attrs = this.parseAttributes();
            if (this.check("Keyword", "function"))
                return this.parseFunction(attrs);
            if (this.check("Keyword", "local") && this.tokens[this.pos + 1]?.type === "Keyword" && this.tokens[this.pos + 1].value === "function") {
                this.consume();
                return this.parseLocalFunctionWithAttrs(attrs, start);
            }
            this.errors.push({ message: "Attributes must precede 'function' or 'local function'", loc: this.loc() });
            this.skipUnknownStatement();
            return null;
        }
        if (this.check("Keyword", "function"))
            return this.parseFunction();
        if (this.check("Identifier") && this.peek().value === "type") {
            const next = this.tokens[this.pos + 1];
            if (next && (next.type === "Identifier" || (next.type === "Keyword" && next.value === "function"))) {
                return this.parseTypeOrTypeFunction();
            }
        }
        if (this.check("Keyword", "export"))
            return this.parseExportOrTypeStatement();
        if (!this.check("Identifier") && !this.check("Punctuator", "(")) {
            this.errors.push({ message: `Unexpected ${this.peek().type}`, loc: this.loc() });
            this.consume();
            return null;
        }
        const prefix = this.parsePrefixExp();
        if (!prefix)
            return null;
        if (this.check("Punctuator", ",") || this.check("Punctuator", "=")) {
            return this.parseAssignment(prefix);
        }
        const op = this.peek();
        if (op.type === "Punctuator" && COMPOUND_OPS.has(op.value)) {
            return this.parseCompoundAssignment(prefix);
        }
        if (this.isCall(prefix)) {
            return { type: "FunctionCallStatement", call: prefix, loc: prefix.loc };
        }
        this.errors.push({ message: "Expected statement", loc: prefix.loc });
        this.consume();
        return null;
    }
    parseTypeOrTypeFunction() {
        const start = this.loc();
        this.consume();
        if (this.check("Keyword", "function")) {
            this.consume();
            const nameTok = this.expect("Identifier");
            if (!nameTok)
                return null;
            const fn = this.parseFunctionBody();
            if (!fn)
                return null;
            return {
                type: "TypeFunctionStatement",
                name: nameTok.value,
                generics: fn.generics,
                params: fn.params,
                returnType: fn.returnType,
                body: fn.body,
                loc: this.mergeLoc(start),
            };
        }
        return this.parseTypeStatement(start);
    }
    parseTypeStatement(start) {
        const loc = start ?? this.loc();
        const nameTok = this.expect("Identifier");
        if (!nameTok)
            return null;
        const name = nameTok.value;
        let generics;
        const gen = this.parseGenericTypeListWithDefaultsInContext();
        if (gen)
            generics = gen;
        if (!this.expect("Punctuator", "="))
            return null;
        const value = this.parseTypeInContext();
        if (!value)
            return null;
        return { type: "TypeStatement", name, generics, value, loc: this.mergeLoc(loc) };
    }
    parseExportOrTypeStatement() {
        const start = this.loc();
        this.consume();
        if (!(this.check("Identifier") && this.peek().value === "type")) {
            this.skipUnknownStatement();
            return null;
        }
        this.consume();
        if (this.check("Keyword", "function")) {
            this.consume();
            const nameTok = this.expect("Identifier");
            if (!nameTok)
                return null;
            const fn = this.parseFunctionBody();
            if (!fn)
                return null;
            return {
                type: "ExportTypeFunctionStatement",
                name: nameTok.value,
                generics: fn.generics,
                params: fn.params,
                returnType: fn.returnType,
                body: fn.body,
                loc: this.mergeLoc(start),
            };
        }
        const nameTok = this.expect("Identifier");
        if (!nameTok)
            return null;
        const name = nameTok.value;
        let generics;
        const gen = this.parseGenericTypeListWithDefaultsInContext();
        if (gen)
            generics = gen;
        if (!this.expect("Punctuator", "="))
            return null;
        const value = this.parseTypeInContext();
        if (!value)
            return null;
        return { type: "ExportTypeStatement", name, generics, value, loc: this.mergeLoc(start) };
    }
    skipUnknownStatement() {
        this.consume();
        const nextStmtKeywords = ["local", "function", "do", "while", "repeat", "if", "for", "return", "break", "export"];
        while (!this.isEOF()) {
            const t = this.peek();
            if (t.type === "EOF")
                break;
            if (t.type === "Keyword" && nextStmtKeywords.includes(t.value))
                break;
            if (t.type === "Identifier" && (t.value === "continue" || t.value === "type"))
                break;
            this.consume();
        }
    }
    isContinueStatement() {
        const next = this.tokens[this.pos + 1];
        if (!next)
            return true;
        if (next.type === "Punctuator") {
            const v = next.value;
            return !["(", ".", "[", ":", "{", "=", ","].includes(v);
        }
        if (next.type === "String")
            return false;
        return true;
    }
    parseReturn() {
        const start = this.loc();
        this.consume();
        const values = this.parseExpList();
        return { type: "ReturnStatement", values: values.length ? values : undefined, loc: this.mergeLoc(start) };
    }
    parseBreak() {
        const loc = this.loc();
        this.consume();
        return { type: "BreakStatement", loc: this.mergeLoc(loc) };
    }
    parseContinue() {
        const loc = this.loc();
        this.consume();
        return { type: "ContinueStatement", loc: this.mergeLoc(loc) };
    }
    parseBinding() {
        const id = this.expect("Identifier");
        if (!id)
            return null;
        const name = id.value;
        let type;
        if (this.check("Punctuator", ":")) {
            this.consume();
            type = this.parseTypeInContext() ?? undefined;
        }
        return { name, type };
    }
    parseLocalOrLocalFunction() {
        const start = this.loc();
        this.consume();
        if (this.check("Keyword", "function")) {
            this.consume();
            const name = this.expect("Identifier");
            if (!name)
                return null;
            const fn = this.parseFunctionBody();
            if (!fn)
                return null;
            return {
                type: "LocalFunctionStatement",
                name: name.value,
                generics: fn.generics,
                params: fn.params,
                returnType: fn.returnType,
                body: fn.body,
                loc: this.mergeLoc(start),
            };
        }
        const vars = [];
        do {
            const binding = this.parseBinding();
            if (!binding)
                return null;
            vars.push(binding);
            if (!this.check("Punctuator", ","))
                break;
            this.consume();
        } while (true);
        let values;
        if (this.check("Punctuator", "=")) {
            this.consume();
            values = this.parseExpList();
        }
        return { type: "LocalStatement", vars, values, loc: this.mergeLoc(start) };
    }
    parseLocalFunctionWithAttrs(attrs, start) {
        this.consume();
        const name = this.expect("Identifier");
        if (!name)
            return null;
        const fn = this.parseFunctionBody();
        if (!fn)
            return null;
        return {
            type: "LocalFunctionStatement",
            name: name.value,
            attributes: attrs.length ? attrs : undefined,
            generics: fn.generics,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            loc: this.mergeLoc(start),
        };
    }
    parseAttributes() {
        const attrs = [];
        while (this.check("Punctuator", "@")) {
            this.consume();
            if (this.check("Punctuator", "[")) {
                this.consume();
                do {
                    const nameTok = this.expect("Identifier");
                    if (!nameTok)
                        break;
                    const attr = { name: nameTok.value };
                    if (this.check("Punctuator", "(")) {
                        this.consume();
                        const args = [];
                        while (!this.check("Punctuator", ")")) {
                            const t = this.peek();
                            if (t.type === "Number") {
                                this.consume();
                                const v = t.value;
                                args.push(v.includes(".") ? parseFloat(v) : parseInt(v, 10));
                            }
                            else if (t.type === "String") {
                                this.consume();
                                args.push(t.value);
                            }
                            else if (t.type === "Keyword" && (t.value === "true" || t.value === "false")) {
                                this.consume();
                                args.push(t.value === "true");
                            }
                            else {
                                break;
                            }
                            if (!this.check("Punctuator", ","))
                                break;
                            this.consume();
                        }
                        this.expect("Punctuator", ")");
                        attr.args = args;
                    }
                    attrs.push(attr);
                    if (!this.check("Punctuator", ","))
                        break;
                    this.consume();
                } while (true);
                this.expect("Punctuator", "]");
            }
            else {
                const nameTok = this.expect("Identifier");
                if (nameTok)
                    attrs.push({ name: nameTok.value });
            }
        }
        return attrs;
    }
    parseDo() {
        const start = this.loc();
        this.consume();
        const body = this.parseBlock();
        this.expect("Keyword", "end");
        return { type: "DoStatement", body, loc: this.mergeLoc(start) };
    }
    parseWhile() {
        const start = this.loc();
        this.consume();
        const condition = this.parseExpression();
        if (!condition)
            return null;
        this.expect("Keyword", "do");
        const body = this.parseBlock();
        this.expect("Keyword", "end");
        return { type: "WhileStatement", condition, body, loc: this.mergeLoc(start) };
    }
    parseRepeat() {
        const start = this.loc();
        this.consume();
        const body = this.parseBlock();
        this.expect("Keyword", "until");
        const condition = this.parseExpression();
        if (!condition)
            return null;
        return { type: "RepeatStatement", body, condition, loc: this.mergeLoc(start) };
    }
    parseIf() {
        const start = this.loc();
        this.consume();
        const condition = this.parseExpression();
        if (!condition)
            return null;
        this.expect("Keyword", "then");
        const thenBody = this.parseBlock();
        const elseifClauses = [];
        while (this.check("Keyword", "elseif")) {
            this.consume();
            const c = this.parseExpression();
            if (!c)
                return null;
            this.expect("Keyword", "then");
            elseifClauses.push({ condition: c, body: this.parseBlock() });
        }
        let elseBody;
        if (this.check("Keyword", "else")) {
            this.consume();
            elseBody = this.parseBlock();
        }
        this.expect("Keyword", "end");
        return { type: "IfStatement", condition, thenBody, elseifClauses, elseBody, loc: this.mergeLoc(start) };
    }
    parseFor() {
        const start = this.loc();
        this.consume();
        const first = this.expect("Identifier");
        if (!first)
            return null;
        if (this.check("Punctuator", "=")) {
            this.consume();
            const startExp = this.parseExpression();
            if (!startExp)
                return null;
            this.expect("Punctuator", ",");
            const endExp = this.parseExpression();
            if (!endExp)
                return null;
            let step;
            if (this.check("Punctuator", ",")) {
                this.consume();
                step = this.parseExpression() ?? undefined;
            }
            this.expect("Keyword", "do");
            const body = this.parseBlock();
            this.expect("Keyword", "end");
            return {
                type: "ForNumericStatement",
                var: { type: "Identifier", name: first.value, loc: first.loc },
                start: startExp,
                end: endExp,
                step,
                body,
                loc: this.mergeLoc(start),
            };
        }
        const vars = [
            { type: "Identifier", name: first.value, loc: first.loc },
        ];
        while (this.check("Punctuator", ",")) {
            this.consume();
            const id = this.expect("Identifier");
            if (!id)
                return null;
            vars.push({ type: "Identifier", name: id.value, loc: id.loc });
        }
        if (this.check("Keyword", "in")) {
            this.consume();
            const iter = this.parseExpList();
            if (!iter.length)
                return null;
            this.expect("Keyword", "do");
            const body = this.parseBlock();
            this.expect("Keyword", "end");
            return { type: "ForInStatement", vars, iter, body, loc: this.mergeLoc(start) };
        }
        this.errors.push({ message: "Invalid for statement", loc: this.loc() });
        return null;
    }
    parseFunction(attrs) {
        const start = this.loc();
        this.consume();
        const name = this.parseFuncName();
        if (!name)
            return null;
        const fn = this.parseFunctionBody();
        if (!fn)
            return null;
        return {
            type: "FunctionStatement",
            name,
            attributes: attrs?.length ? attrs : undefined,
            generics: fn.generics,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            loc: this.mergeLoc(start),
        };
    }
    parseFuncName() {
        const base = this.parseFuncNamePart();
        if (!base)
            return null;
        let method;
        if (this.check("Punctuator", ":")) {
            this.consume();
            const m = this.expect("Identifier");
            if (!m)
                return null;
            method = m.value;
        }
        return { type: "FuncName", base, method, loc: base.loc };
    }
    parseFuncNamePart() {
        const id = this.expect("Identifier");
        if (!id)
            return null;
        let obj = { type: "Identifier", name: id.value, loc: id.loc };
        while (this.check("Punctuator", ".")) {
            this.consume();
            const prop = this.expect("Identifier");
            if (!prop)
                return null;
            obj = { type: "MemberExpression", object: obj, property: prop.value, loc: this.mergeLoc(obj.loc) };
        }
        return obj;
    }
    parseFunctionGenerics() {
        if (!this.check("Punctuator", "<"))
            return undefined;
        this.consume();
        const generics = [];
        while (true) {
            const t = this.peek();
            if (t.type === "Identifier") {
                generics.push(t.value);
                this.consume();
                if (this.check("Punctuator", "..."))
                    this.consume();
            }
            else if (t.type === "Punctuator" && t.value === ">") {
                break;
            }
            else {
                break;
            }
            if (!this.check("Punctuator", ","))
                break;
            this.consume();
        }
        if (!this.expect("Punctuator", ">"))
            return undefined;
        return generics.length ? generics : undefined;
    }
    parseFunctionBody() {
        const generics = this.parseFunctionGenerics();
        this.expect("Punctuator", "(");
        const params = [];
        if (!this.check("Punctuator", ")")) {
            if (this.check("Punctuator", "...")) {
                this.consume();
                let varargType;
                if (this.check("Punctuator", ":")) {
                    this.consume();
                    varargType = this.parseTypeInContext() ?? undefined;
                }
                params.push({
                    type: "Param",
                    name: "...",
                    typeAnnotation: varargType,
                    variadic: true,
                    loc: this.loc(),
                });
            }
            else {
                do {
                    const binding = this.parseBinding();
                    if (!binding)
                        return null;
                    params.push({
                        type: "Param",
                        name: binding.name,
                        typeAnnotation: binding.type,
                        loc: this.loc(),
                    });
                    if (!this.check("Punctuator", ","))
                        break;
                    this.consume();
                    if (this.check("Punctuator", "...")) {
                        this.consume();
                        let varargType;
                        if (this.check("Punctuator", ":")) {
                            this.consume();
                            varargType = this.parseTypeInContext() ?? undefined;
                        }
                        params.push({
                            type: "Param",
                            name: "...",
                            typeAnnotation: varargType,
                            variadic: true,
                            loc: this.loc(),
                        });
                        break;
                    }
                } while (true);
            }
        }
        this.expect("Punctuator", ")");
        let returnType;
        if (this.check("Punctuator", ":")) {
            this.consume();
            returnType = this.parseReturnTypeInContext() ?? undefined;
        }
        const body = this.parseBlock();
        this.expect("Keyword", "end");
        return { generics, params, returnType, body };
    }
    parseAssignment(prefix) {
        const vars = [prefix];
        while (this.check("Punctuator", ",")) {
            this.consume();
            const v = this.parsePrefixExp();
            if (!v)
                return null;
            vars.push(v);
        }
        if (!this.check("Punctuator", "=")) {
            this.errors.push({ message: "Expected '=' in assignment", loc: this.loc() });
            return null;
        }
        this.consume();
        const values = this.parseExpList();
        return { type: "AssignmentStatement", vars, values, loc: this.mergeLoc(prefix.loc) };
    }
    parseCompoundAssignment(prefix) {
        const op = this.consume();
        const value = this.parseExpression();
        if (!value)
            return null;
        return {
            type: "CompoundAssignmentStatement",
            var: prefix,
            operator: op.value,
            value,
            loc: this.mergeLoc(prefix.loc),
        };
    }
    parseBlock() {
        const body = [];
        while (!this.isEOF()) {
            const _bt = this.peek();
            if (_bt.type === "Keyword" && BLOCK_END_KEYWORDS.has(_bt.value))
                break;
            if (this.check("Punctuator", ";")) {
                this.consume();
                continue;
            }
            const stmt = this.parseStatementOrLast();
            if (stmt) {
                body.push(stmt);
                if (stmt.type === "ReturnStatement" || stmt.type === "BreakStatement" || stmt.type === "ContinueStatement") {
                    if (this.check("Punctuator", ";"))
                        this.consume();
                    break;
                }
            }
        }
        return body;
    }
    parsePrefixExp() {
        const t = this.peek();
        if (t.type === "Identifier") {
            return this.parsePrefixExpAfterIdentifier();
        }
        if (t.type === "Punctuator" && t.value === "(") {
            this.consume();
            const exp = this.parseExpression();
            if (!exp)
                return null;
            this.expect("Punctuator", ")");
            return this.parseSuffixExp({ type: "ParenExpression", expression: exp, loc: this.mergeLoc(exp.loc) });
        }
        return null;
    }
    parsePrefixExpAfterIdentifier() {
        const id = this.consume();
        const base = { type: "Identifier", name: id.value, loc: id.loc };
        return this.parseSuffixExp(base);
    }
    parseSuffixExp(base) {
        while (true) {
            const t = this.peek();
            if (t.type === "Punctuator") {
                if (t.value === "(") {
                    this.consume();
                    const args = this.parseExpList();
                    this.expect("Punctuator", ")");
                    base = { type: "CallExpression", callee: base, args, loc: this.mergeLoc(base.loc) };
                    continue;
                }
                if (t.value === "{") {
                    const table = this.parseTableConstructor();
                    if (!table)
                        return null;
                    base = { type: "CallExpression", callee: base, args: [table], loc: this.mergeLoc(base.loc) };
                    continue;
                }
                if (t.value === "[") {
                    this.consume();
                    const index = this.parseExpression();
                    if (!index)
                        return null;
                    this.expect("Punctuator", "]");
                    base = { type: "IndexExpression", object: base, index, loc: this.mergeLoc(base.loc) };
                    continue;
                }
                if (t.value === ".") {
                    this.consume();
                    const prop = this.expect("Identifier");
                    if (!prop)
                        return null;
                    base = { type: "MemberExpression", object: base, property: prop.value, loc: this.mergeLoc(base.loc) };
                    continue;
                }
                if (t.value === ":") {
                    this.consume();
                    const method = this.expect("Identifier");
                    if (!method)
                        return null;
                    const nextT = this.peek();
                    if (nextT.type === "String") {
                        this.consume();
                        base = { type: "MethodCallExpression", object: base, method: method.value, args: [{ type: "StringLiteral", value: nextT.value, loc: nextT.loc }], loc: this.mergeLoc(base.loc) };
                    }
                    else if (nextT.type === "Punctuator" && nextT.value === "{") {
                        const table = this.parseTableConstructor();
                        if (!table)
                            return null;
                        base = { type: "MethodCallExpression", object: base, method: method.value, args: [table], loc: this.mergeLoc(base.loc) };
                    }
                    else {
                        this.expect("Punctuator", "(");
                        const args = this.parseExpList();
                        this.expect("Punctuator", ")");
                        base = { type: "MethodCallExpression", object: base, method: method.value, args, loc: this.mergeLoc(base.loc) };
                    }
                    continue;
                }
            }
            if (t.type === "String") {
                this.consume();
                base = { type: "CallExpression", callee: base, args: [{ type: "StringLiteral", value: t.value, loc: t.loc }], loc: this.mergeLoc(base.loc) };
                continue;
            }
            break;
        }
        return base;
    }
    isCall(exp) {
        return exp.type === "CallExpression" || exp.type === "MethodCallExpression";
    }
    parseExpression(prec = 0) {
        let left = null;
        const t = this.peek();
        if (t.type === "Punctuator" && t.value === "-") {
            const op = this.consume();
            const arg = this.parseExpression(6);
            if (!arg)
                return null;
            left = { type: "UnaryExpression", operator: "-", argument: arg, loc: this.mergeLoc(arg.loc) };
        }
        else if (t.type === "Keyword" && t.value === "not") {
            this.consume();
            const arg = this.parseExpression(6);
            if (!arg)
                return null;
            left = { type: "UnaryExpression", operator: "not", argument: arg, loc: this.mergeLoc(arg.loc) };
        }
        else if (t.type === "Punctuator" && t.value === "#") {
            this.consume();
            const arg = this.parseExpression(6);
            if (!arg)
                return null;
            left = { type: "UnaryExpression", operator: "#", argument: arg, loc: this.mergeLoc(arg.loc) };
        }
        else {
            left = this.parseAsexp();
        }
        if (!left)
            return null;
        while (true) {
            const op = this.peek();
            if (op.type !== "Punctuator" && op.type !== "Keyword")
                break;
            const opStr = op.value;
            const p = BINARY_PRECEDENCE[opStr];
            if (p === undefined || p <= prec)
                break;
            const isRightAssoc = opStr === "^" || opStr === "..";
            this.consume();
            const right = this.parseExpression(isRightAssoc ? p - 1 : p);
            if (!right)
                return null;
            left = { type: "BinaryExpression", operator: opStr, left, right, loc: this.mergeLoc(left.loc) };
        }
        return left;
    }
    parseAsexp() {
        const exp = this.parseSimpleExp();
        if (!exp)
            return null;
        if (this.check("Punctuator", "::")) {
            this.consume();
            const assertedType = this.parseTypeInContext();
            if (!assertedType)
                return exp;
            return {
                type: "TypeAssertion",
                expression: exp,
                assertedType,
                loc: this.mergeLoc(exp.loc),
            };
        }
        return exp;
    }
    parseSimpleExp() {
        const t = this.peek();
        if (t.type === "Keyword") {
            const v = t.value;
            if (v === "nil") {
                this.consume();
                return { type: "NilLiteral", loc: t.loc };
            }
            if (v === "true" || v === "false") {
                this.consume();
                return { type: "BooleanLiteral", value: v === "true", loc: t.loc };
            }
        }
        if (t.type === "Number") {
            this.consume();
            return { type: "NumberLiteral", value: t.value, raw: t.raw, loc: t.loc };
        }
        if (t.type === "String") {
            this.consume();
            return { type: "StringLiteral", value: t.value, loc: t.loc };
        }
        if (t.type === "InterpPart") {
            return this.parseStringInterpolation();
        }
        if (t.type === "Punctuator" && t.value === "...") {
            this.consume();
            return { type: "VarargExpression", loc: t.loc };
        }
        if (t.type === "Punctuator" && t.value === "{") {
            return this.parseTableConstructor();
        }
        if (t.type === "Punctuator" && t.value === "@") {
            const attrs = this.parseAttributes();
            if (this.check("Keyword", "function")) {
                return this.parseFunctionExpression(attrs);
            }
            this.errors.push({ message: "Attributes must precede 'function'", loc: this.loc() });
            return null;
        }
        if (t.type === "Keyword" && t.value === "function") {
            return this.parseFunctionExpression();
        }
        if (t.type === "Keyword" && t.value === "if") {
            return this.parseIfElseExpression();
        }
        if (t.type === "Punctuator" && t.value === "(") {
            this.consume();
            const exp = this.parseExpression();
            if (!exp)
                return null;
            this.expect("Punctuator", ")");
            const paren = { type: "ParenExpression", expression: exp, loc: this.mergeLoc(exp.loc) };
            return this.parseSuffixExp(paren);
        }
        if (t.type === "Identifier") {
            return this.parsePrefixExp();
        }
        return null;
    }
    parseIfElseExpression() {
        const start = this.loc();
        this.consume();
        const condition = this.parseExpression();
        if (!condition)
            return null;
        this.expect("Keyword", "then");
        const thenExp = this.parseExpression();
        if (!thenExp)
            return null;
        const elseifClauses = [];
        while (this.check("Keyword", "elseif")) {
            this.consume();
            const c = this.parseExpression();
            if (!c)
                return null;
            this.expect("Keyword", "then");
            const v = this.parseExpression();
            if (!v)
                return null;
            elseifClauses.push({ condition: c, value: v });
        }
        this.expect("Keyword", "else");
        const elseExp = this.parseExpression();
        if (!elseExp)
            return null;
        return {
            type: "IfElseExpression",
            condition,
            thenExp,
            elseifClauses,
            elseExp,
            loc: this.mergeLoc(start),
        };
    }
    parseStringInterpolation() {
        const start = this.loc();
        const parts = [];
        const first = this.peek();
        if (first.type !== "InterpPart")
            return null;
        this.consume();
        parts.push(first.value);
        while (this.check("Punctuator", "{")) {
            this.consume();
            const exp = this.parseExpression();
            if (!exp)
                return null;
            parts.push(exp);
            if (!this.expect("Punctuator", "}"))
                return null;
            if (this.check("InterpPart")) {
                const part = this.consume();
                parts.push(part.value);
            }
        }
        return {
            type: "StringInterpolation",
            parts,
            loc: this.mergeLoc(start),
        };
    }
    parseTableConstructor() {
        const start = this.loc();
        this.consume();
        const fields = [];
        while (!this.check("Punctuator", "}")) {
            if (this.check("Punctuator", ",") || this.check("Punctuator", ";")) {
                this.consume();
                continue;
            }
            if (this.check("Punctuator", "[")) {
                this.consume();
                const index = this.parseExpression();
                if (!index)
                    return null;
                this.expect("Punctuator", "]");
                this.expect("Punctuator", "=");
                const value = this.parseExpression();
                if (!value)
                    return null;
                fields.push({ kind: "index", index, value });
            }
            else if (this.check("Identifier") && this.tokens[this.pos + 1]?.type === "Punctuator" && this.tokens[this.pos + 1].value === "=") {
                const id = this.consume();
                this.consume();
                const value = this.parseExpression();
                if (!value)
                    return null;
                fields.push({ kind: "named", name: id.value, value });
            }
            else {
                const value = this.parseExpression();
                if (!value)
                    return null;
                fields.push({ kind: "value", value });
            }
            if (this.check("Punctuator", ",") || this.check("Punctuator", ";"))
                this.consume();
        }
        this.expect("Punctuator", "}");
        return { type: "TableConstructor", fields, loc: this.mergeLoc(start) };
    }
    parseFunctionExpression(attrs) {
        const start = this.loc();
        this.consume();
        const fn = this.parseFunctionBody();
        if (!fn)
            return null;
        return {
            type: "FunctionExpression",
            attributes: attrs?.length ? attrs : undefined,
            generics: fn.generics,
            params: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            loc: this.mergeLoc(start),
        };
    }
    parseExpList() {
        const list = [];
        const exp = this.parseExpression();
        if (!exp)
            return list;
        list.push(exp);
        while (this.check("Punctuator", ",")) {
            this.consume();
            const e = this.parseExpression();
            if (!e)
                break;
            list.push(e);
        }
        return list;
    }
    mergeLoc(loc) {
        const end = this.loc().end;
        return { start: loc.start, end };
    }
}
export function parse(tokens) {
    return new Parser(tokens).parse();
}
export function parseWithErrors(tokens) {
    const parser = new Parser(tokens);
    const ast = parser.parse();
    return { ast, errors: parser.getErrors() };
}
//# sourceMappingURL=Parser.js.map