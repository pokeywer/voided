export function parseType(ctx) {
    return parseUnion(ctx);
}
function parseUnion(ctx) {
    const types = [];
    let first = parseSimpleTypeWithOptional(ctx);
    if (!first)
        return null;
    types.push(first);
    while (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "|") {
        ctx.pos++;
        const next = parseSimpleTypeWithOptional(ctx);
        if (!next)
            return null;
        types.push(next);
    }
    if (types.length === 1 && !types[0].optional)
        return types[0].type;
    const start = types[0].type.loc.start;
    const end = types[types.length - 1].type.loc.end;
    return {
        type: "UnionType",
        types,
        loc: { start, end },
    };
}
function parseSimpleTypeWithOptional(ctx) {
    const t = parseIntersection(ctx);
    if (!t)
        return null;
    let optional = false;
    if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "?") {
        ctx.pos++;
        optional = true;
    }
    return { type: t, optional };
}
function parseIntersection(ctx) {
    const types = [];
    let first = parseSimpleType(ctx);
    if (!first)
        return null;
    types.push(first);
    while (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "&") {
        ctx.pos++;
        const next = parseSimpleType(ctx);
        if (!next)
            return null;
        types.push(next);
    }
    if (types.length === 1)
        return types[0];
    const start = types[0].loc.start;
    const end = types[types.length - 1].loc.end;
    return {
        type: "IntersectionType",
        types,
        loc: { start, end },
    };
}
function isFunctionTypeLookahead(ctx) {
    let depth = 0;
    let i = ctx.pos;
    const t = ctx.tokens[i];
    if (!t || t.type !== "Punctuator" || t.value !== "(")
        return false;
    while (i < ctx.tokens.length) {
        const tok = ctx.tokens[i];
        if (tok.type === "Punctuator") {
            const val = tok.value;
            if (val === "(" || val === "{" || val === "<") {
                depth++;
            }
            else if (val === ")" || val === "}" || val === ">") {
                depth--;
                if (depth === 0) {
                    const next = ctx.tokens[i + 1];
                    if (next && next.type === "Punctuator" && next.value === "->") {
                        return true;
                    }
                    return false;
                }
            }
        }
        i++;
    }
    return false;
}
function parseSimpleType(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (!tok)
        return null;
    if (tok.type === "Punctuator" && tok.value === "...") {
        ctx.pos++;
        const inner = parseType(ctx);
        if (!inner)
            return null;
        return { type: "VariadicTypePack", inner, loc: tok.loc };
    }
    if (tok.type === "Keyword" && tok.value === "nil") {
        ctx.pos++;
        return { type: "NilType", loc: tok.loc };
    }
    if (tok.type === "Keyword" && (tok.value === "true" || tok.value === "false")) {
        ctx.pos++;
        return {
            type: "SingletonType",
            value: tok.value === "true",
            loc: tok.loc,
        };
    }
    if (tok.type === "String") {
        ctx.pos++;
        return {
            type: "SingletonType",
            value: tok.value,
            loc: tok.loc,
        };
    }
    if ((tok.type === "Keyword" || tok.type === "Identifier") && tok.value === "typeof") {
        ctx.pos++;
        const lp = ctx.tokens[ctx.pos];
        if (lp?.type !== "Punctuator" || lp.value !== "(")
            return null;
        ctx.pos++;
        const exp = ctx.parseExpression();
        if (!exp)
            return null;
        const rp = ctx.tokens[ctx.pos];
        if (rp?.type !== "Punctuator" || rp.value !== ")")
            return null;
        ctx.pos++;
        return {
            type: "TypeofType",
            expression: exp,
            loc: ctx.mergeLoc(exp.loc),
        };
    }
    if (tok.type === "Punctuator" && tok.value === "(") {
        if (isFunctionTypeLookahead(ctx)) {
            return parseFunctionType(ctx);
        }
        ctx.pos++;
        const first = parseType(ctx);
        if (!first)
            return null;
        if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === ",") {
            ctx.pos++;
            const types = [first];
            while (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")") {
                if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "...") {
                    ctx.pos++;
                    const inner = parseType(ctx);
                    if (!inner)
                        return null;
                    types.push({ type: "VariadicTypePack", inner, loc: inner.loc });
                }
                else {
                    const ty = parseType(ctx);
                    if (!ty)
                        break;
                    types.push(ty);
                }
                if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
                    break;
                ctx.pos++;
            }
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")")
                return null;
            ctx.pos++;
            return { type: "TypePack", types, loc: tok.loc };
        }
        else {
            const rp = ctx.tokens[ctx.pos];
            if (rp?.type !== "Punctuator" || rp.value !== ")")
                return null;
            ctx.pos++;
            return {
                type: "ParenType",
                inner: first,
                loc: ctx.mergeLoc(first.loc),
            };
        }
    }
    if (tok.type === "Punctuator" && tok.value === "{") {
        return parseTableType(ctx);
    }
    if (tok.type === "Keyword" && tok.value === "(") {
        return null;
    }
    const ft = parseFunctionType(ctx);
    if (ft)
        return ft;
    if (tok.type === "Identifier" || (tok.type === "Keyword" && ["any", "nil", "boolean", "number", "string", "thread", "read", "write"].includes(tok.value))) {
        return parseIdentifierType(ctx);
    }
    return null;
}
function parseIdentifierType(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (!tok || (tok.type !== "Identifier" && tok.type !== "Keyword"))
        return null;
    const start = tok.loc.start;
    let name = tok.value;
    ctx.pos++;
    let module;
    while (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === ".") {
        ctx.pos++;
        const next = ctx.tokens[ctx.pos];
        if (next?.type !== "Identifier" && next?.type !== "Keyword")
            return null;
        module = name;
        name = next.value;
        ctx.pos++;
    }
    let typeParams;
    if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "<") {
        ctx.pos++;
        typeParams = parseTypeParams(ctx);
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ">")
            return null;
        ctx.pos++;
    }
    const end = ctx.tokens[ctx.pos - 1]?.loc?.end ?? start;
    return {
        type: "IdentifierType",
        name,
        module,
        typeParams,
        loc: { start, end },
    };
}
function parseTypeParams(ctx) {
    const params = [];
    while (true) {
        const t = ctx.tokens[ctx.pos];
        if (!t || (t.type === "Punctuator" && t.value === ">"))
            break;
        if (t.type === "Identifier" && ctx.tokens[ctx.pos + 1]?.type === "Punctuator" && ctx.tokens[ctx.pos + 1].value === "...") {
            ctx.pos += 2;
            params.push({ type: "GenericTypePack", name: t.value, loc: t.loc });
        }
        else if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "...") {
            ctx.pos++;
            const inner = parseType(ctx);
            if (!inner)
                break;
            params.push({ type: "VariadicTypePack", inner, loc: inner.loc });
        }
        else if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "(") {
            const pack = parseTypePack(ctx);
            if (pack)
                params.push(pack);
        }
        else {
            const ty = parseType(ctx);
            if (ty)
                params.push(ty);
            else
                break;
        }
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
            break;
        ctx.pos++;
    }
    return params;
}
function parseTypePack(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (tok?.type !== "Punctuator" || tok.value !== "(")
        return null;
    ctx.pos++;
    const types = [];
    while (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")") {
        if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "...") {
            ctx.pos++;
            const inner = parseType(ctx);
            if (!inner)
                return null;
            types.push({ type: "VariadicTypePack", inner, loc: inner.loc });
        }
        else {
            const ty = parseType(ctx);
            if (!ty)
                break;
            types.push(ty);
        }
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
            break;
        ctx.pos++;
    }
    if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")")
        return null;
    ctx.pos++;
    return { type: "TypePack", types, loc: tok.loc };
}
function parseTableType(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (tok?.type !== "Punctuator" || tok.value !== "{")
        return null;
    const start = tok.loc.start;
    ctx.pos++;
    const next = ctx.tokens[ctx.pos];
    if (next) {
        const savedPos = ctx.pos;
        const single = parseType(ctx);
        if (single && ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "}") {
            ctx.pos++;
            return { type: "TableType", arrayType: single, loc: { start, end: ctx.tokens[ctx.pos - 1].loc.end } };
        }
        ctx.pos = savedPos;
    }
    const props = [];
    const fieldsep = [",", ";"];
    while (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== "}") {
        const t = ctx.tokens[ctx.pos];
        if (!t)
            break;
        if ((t.type === "Keyword" || t.type === "Identifier") && (t.value === "read" || t.value === "write")) {
            const savedPos = ctx.pos;
            const ro = t.value === "read";
            ctx.pos++;
            const next2 = ctx.tokens[ctx.pos];
            let processed = false;
            if (next2?.type === "Punctuator" && next2.value === "[") {
                ctx.pos++;
                const indexType = parseType(ctx);
                if (indexType && ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "]") {
                    ctx.pos++;
                    if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === ":") {
                        ctx.pos++;
                        const valueType = parseType(ctx);
                        if (valueType) {
                            props.push({
                                type: "TableIndexerType",
                                indexType,
                                valueType,
                                readOnly: ro,
                                writeOnly: !ro,
                                loc: t.loc,
                            });
                            processed = true;
                        }
                    }
                }
            }
            else if (next2?.type === "Identifier" || next2?.type === "Keyword") {
                const name = next2.value;
                ctx.pos++;
                if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === ":") {
                    ctx.pos++;
                    const propType = parseType(ctx);
                    if (propType) {
                        props.push({
                            type: "TablePropType",
                            name,
                            propType,
                            readOnly: ro,
                            writeOnly: !ro,
                            loc: t.loc,
                        });
                        processed = true;
                    }
                }
            }
            if (!processed) {
                ctx.pos = savedPos;
                const name = t.value;
                ctx.pos++;
                if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ":")
                    break;
                ctx.pos++;
                const propType = parseType(ctx);
                if (!propType)
                    break;
                props.push({ type: "TablePropType", name, propType, loc: t.loc });
            }
        }
        else if (t.type === "Punctuator" && t.value === "[") {
            ctx.pos++;
            const indexType = parseType(ctx);
            if (!indexType)
                break;
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== "]")
                break;
            ctx.pos++;
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ":")
                break;
            ctx.pos++;
            const valueType = parseType(ctx);
            if (!valueType)
                break;
            props.push({ type: "TableIndexerType", indexType, valueType, loc: t.loc });
        }
        else if (t.type === "Identifier" || t.type === "Keyword") {
            const name = t.value;
            ctx.pos++;
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ":")
                break;
            ctx.pos++;
            const propType = parseType(ctx);
            if (!propType)
                break;
            props.push({ type: "TablePropType", name, propType, loc: t.loc });
        }
        else {
            break;
        }
        const sep = ctx.tokens[ctx.pos];
        if (sep?.type === "Punctuator" && fieldsep.includes(sep.value))
            ctx.pos++;
    }
    if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== "}")
        return null;
    ctx.pos++;
    return { type: "TableType", props, loc: { start, end: ctx.tokens[ctx.pos - 1].loc.end } };
}
function parseFunctionType(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (!tok)
        return null;
    let generics;
    if (tok.type === "Punctuator" && tok.value === "<") {
        ctx.pos++;
        generics = [];
        while (true) {
            const t = ctx.tokens[ctx.pos];
            if (!t)
                break;
            if (t.type === "Identifier") {
                let name = t.value;
                ctx.pos++;
                if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "...") {
                    ctx.pos++;
                    name += "...";
                }
                generics.push(name);
            }
            else if (t.type === "Punctuator" && t.value === ">") {
                break;
            }
            else {
                break;
            }
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
                break;
            ctx.pos++;
        }
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ">")
            return null;
        ctx.pos++;
    }
    const lp = ctx.tokens[ctx.pos];
    if (lp?.type !== "Punctuator" || lp.value !== "(")
        return generics ? null : null;
    ctx.pos++;
    const params = [];
    while (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")") {
        const t = ctx.tokens[ctx.pos];
        if (t?.type === "Identifier" && ctx.tokens[ctx.pos + 1]?.type === "Punctuator" && ctx.tokens[ctx.pos + 1].value === "...") {
            ctx.pos += 2;
            params.push({ type: "GenericTypePack", name: t.value, loc: t.loc });
        }
        else if (t?.type === "Punctuator" && t.value === "...") {
            ctx.pos++;
            const inner = parseType(ctx);
            if (!inner)
                return null;
            params.push({ type: "VariadicTypePack", inner, loc: inner.loc });
        }
        else if (t?.type === "Identifier" || t?.type === "Keyword") {
            const name = t.value;
            ctx.pos++;
            if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === ":") {
                ctx.pos++;
                const paramType = parseType(ctx);
                if (!paramType)
                    return null;
                params.push({ name, type: paramType });
            }
            else {
                params.push({ type: { type: "IdentifierType", name, loc: t.loc } });
            }
        }
        else {
            const paramType = parseType(ctx);
            if (!paramType)
                break;
            params.push({ type: paramType });
        }
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
            break;
        ctx.pos++;
    }
    if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ")")
        return null;
    ctx.pos++;
    if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== "->")
        return null;
    ctx.pos++;
    const returnType = parseReturnType(ctx);
    if (!returnType)
        return null;
    return {
        type: "FunctionType",
        generics,
        params,
        returnType,
        loc: tok.loc,
    };
}
export function parseReturnType(ctx) {
    const t = ctx.tokens[ctx.pos];
    if (!t)
        return null;
    if (t.type === "Identifier" && ctx.tokens[ctx.pos + 1]?.type === "Punctuator" && ctx.tokens[ctx.pos + 1].value === "...") {
        ctx.pos += 2;
        return { type: "GenericTypePack", name: t.value, loc: t.loc };
    }
    if (t.type === "Punctuator" && t.value === "...") {
        ctx.pos++;
        const inner = parseType(ctx);
        if (!inner)
            return null;
        return { type: "VariadicTypePack", inner, loc: t.loc };
    }
    if (t.type === "Punctuator" && t.value === "(") {
        const pack = parseTypePack(ctx);
        return pack;
    }
    return parseType(ctx);
}
function parseTypePackOrPackDefault(ctx) {
    const t = ctx.tokens[ctx.pos];
    if (!t)
        return null;
    if (t.type === "Identifier" && ctx.tokens[ctx.pos + 1]?.type === "Punctuator" && ctx.tokens[ctx.pos + 1].value === "...") {
        ctx.pos += 2;
        return { type: "GenericTypePack", name: t.value, loc: t.loc };
    }
    if (t.type === "Punctuator" && t.value === "...") {
        ctx.pos++;
        const inner = parseType(ctx);
        if (!inner)
            return null;
        return { type: "VariadicTypePack", inner, loc: inner.loc };
    }
    if (t.type === "Punctuator" && t.value === "(") {
        return parseTypePack(ctx);
    }
    return null;
}
export function parseGenericTypeListWithDefaults(ctx) {
    const tok = ctx.tokens[ctx.pos];
    if (tok?.type !== "Punctuator" || tok.value !== "<")
        return null;
    const start = tok.loc.start;
    ctx.pos++;
    const params = [];
    while (true) {
        const t = ctx.tokens[ctx.pos];
        if (!t || (t.type === "Punctuator" && t.value === ">"))
            break;
        if (t.type === "Identifier" && ctx.tokens[ctx.pos + 1]?.value === "...") {
            const name = t.value + "...";
            ctx.pos += 2;
            if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== "=") {
                params.push({ name });
            }
            else {
                ctx.pos++;
                const def = parseTypePackOrPackDefault(ctx);
                if (!def)
                    break;
                params.push({ name, default: def });
            }
        }
        else if (t.type === "Identifier" || t.type === "Keyword") {
            const name = t.value;
            ctx.pos++;
            let defaultType;
            if (ctx.tokens[ctx.pos]?.type === "Punctuator" && ctx.tokens[ctx.pos].value === "=") {
                ctx.pos++;
                defaultType = parseType(ctx) ?? undefined;
            }
            params.push(defaultType ? { name, default: defaultType } : { name });
        }
        else {
            break;
        }
        if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ",")
            break;
        ctx.pos++;
    }
    if (ctx.tokens[ctx.pos]?.type !== "Punctuator" || ctx.tokens[ctx.pos].value !== ">")
        return null;
    ctx.pos++;
    return { type: "GenericTypeListWithDefaults", params, loc: { start, end: ctx.tokens[ctx.pos - 1].loc.end } };
}
//# sourceMappingURL=TypeParser.js.map