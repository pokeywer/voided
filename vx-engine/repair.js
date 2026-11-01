import { lex } from "./lexer/Lexer.js";
import { parse } from "./parser/Parser.js";
function declaredNames(stmt) {
    const s = stmt;
    if (s.type === "LocalStatement")
        return (s.vars ?? []).map((v) => v.name).filter((n) => !!n);
    if (s.type === "LocalFunctionStatement" && s.name)
        return [s.name];
    return [];
}
function entryContaining(entries, offset) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = entries[mid];
        if (offset < e.start)
            hi = mid - 1;
        else if (offset >= e.end)
            lo = mid + 1;
        else
            return mid;
    }
    return -1;
}
/**
 * The max tier scatters honeypot statements between bootstrap declarations, which can leave a
 * `local X = ...` sitting after the first statement that reads X. Hoist those declarations above
 * their earliest use; every other statement keeps its position.
 */
export function repairTopLevelOrder(code) {
    let ast;
    let source;
    try {
        const { tokens, errors } = lex(code);
        if (errors.length > 0 || tokens.length === 0)
            return { code, moved: 0, note: "skipped: lexer errors" };
        ast = parse(tokens);
        source = code;
    }
    catch (err) {
        return { code, moved: 0, note: `skipped: unparsable (${err instanceof Error ? err.message : "parse"})` };
    }
    const body = ast.body;
    if (body.length < 2)
        return { code, moved: 0, note: "nothing to do" };
    const entries = body.map((stmt) => ({
        start: stmt.loc.start.offset,
        end: stmt.loc.end.offset,
        text: source.slice(stmt.loc.start.offset, stmt.loc.end.offset),
        declares: declaredNames(stmt),
    }));
    const uses = new Map();
    try {
        for (const token of lex(source).tokens) {
            if (token.type !== "Identifier")
                continue;
            const index = entryContaining(entries, token.loc.start.offset);
            if (index < 0)
                continue;
            const list = uses.get(token.value);
            if (list)
                list.push(index);
            else
                uses.set(token.value, [index]);
        }
    }
    catch {
        return { code, moved: 0, note: "skipped: identifier scan failed" };
    }
    const prefix = source.slice(0, entries[0].start);
    const suffix = source.slice(entries[entries.length - 1].end);
    let order = entries.map((_, i) => i);
    let moved = 0;
    for (let pass = 0; pass < 12; pass++) {
        const slotOfEntry = new Map();
        order.forEach((entryIndex, slot) => slotOfEntry.set(entryIndex, slot));
        const declSlot = new Map();
        for (let slot = 0; slot < order.length; slot++) {
            for (const name of entries[order[slot]].declares) {
                if (!declSlot.has(name))
                    declSlot.set(name, slot);
            }
        }
        let hoisted = false;
        for (let slot = 0; slot < order.length && !hoisted; slot++) {
            for (const name of entries[order[slot]].declares) {
                const declaredAt = declSlot.get(name);
                if (declaredAt === undefined)
                    continue;
                const list = uses.get(name);
                if (!list)
                    continue;
                let first = declaredAt;
                for (const entryIndex of list) {
                    const useSlot = slotOfEntry.get(entryIndex);
                    if (useSlot !== undefined && useSlot < first)
                        first = useSlot;
                }
                if (first >= declaredAt)
                    continue;
                order.splice(first, 0, order.splice(declaredAt, 1)[0]);
                moved++;
                hoisted = true;
                break;
            }
        }
        if (!hoisted)
            break;
    }
    if (moved === 0)
        return { code, moved: 0, note: "order already valid" };
    const rebuilt = prefix + order.map((i) => entries[i].text).join("\n") + suffix;
    try {
        const { tokens, errors } = lex(rebuilt);
        if (errors.length > 0)
            return { code, moved: 0, note: "skipped: repair produced invalid syntax" };
        parse(tokens);
    }
    catch {
        return { code, moved: 0, note: "skipped: repair produced unparsable output" };
    }
    return { code: rebuilt, moved, note: `hoisted ${moved} declaration(s)` };
}
//# sourceMappingURL=repair.js.map