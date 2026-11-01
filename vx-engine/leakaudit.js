import { lex } from "./lexer/Lexer.js";
const SKIP_WORDS = new Set([
    "local", "function", "end", "then", "else", "elseif", "return", "if", "for", "while", "do",
    "repeat", "until", "and", "or", "not", "nil", "true", "false", "in", "self", "_",
]);
const KNOWN_GLOBALS = new Set([
    "print", "warn", "error", "assert", "type", "typeof", "tostring", "tonumber", "pcall", "xpcall",
    "select", "unpack", "pairs", "ipairs", "next", "rawget", "rawset", "rawequal", "rawlen",
    "setmetatable", "getmetatable", "string", "table", "math", "bit32", "coroutine", "os", "utf8",
    "debug", "buffer", "game", "workspace", "script", "task", "wait", "spawn", "delay", "tick",
    "time", "require", "loadstring", "load", "_G", "_ENV", "Instance", "Vector3", "Vector2",
    "CFrame", "Color3", "UDim", "UDim2", "Enum", "DateTime", "Random", "getgenv", "shared",
]);
function collect(source) {
    const strings = new Set();
    const names = new Set();
    const api = new Set();
    const { tokens, errors } = lex(source);
    if (errors.length > 0)
        throw new Error(`audit: input does not lex (${errors[0].message ?? "error"})`);
    for (const token of tokens) {
        if (token.type === "String") {
            const value = token.value;
            if (value.length >= 4 && value.trim().length > 0)
                strings.add(value);
        }
        else if (token.type === "Identifier") {
            const name = token.value;
            if (name.length >= 4 && !SKIP_WORDS.has(name) && !KNOWN_GLOBALS.has(name))
                names.add(name);
        }
        else if (token.type === "Keyword" && ["and", "or", "not"].includes(token.value)) {
            void 0;
        }
    }
    for (const match of source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[:.]\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (match[2].length >= 5)
            api.add(match[2]);
    }
    return { strings, names, api };
}
function escapeForRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findLeaked(wanted, haystack, wholeWord) {
    const leaked = [];
    for (const value of wanted) {
        const needle = wholeWord
            ? new RegExp(`\\b${escapeForRegex(value)}\\b`)
            : new RegExp(escapeForRegex(JSON.stringify(value)).replace(/"/g, '["\']'));
        if (needle.test(haystack))
            leaked.push(value);
    }
    return leaked;
}
/**
 * Measures how much of the original program is still readable inside the protected file.
 * Score is 100 when nothing survives the grep, lower as strings/identifiers/API names leak.
 */
export function auditProtection(source, protectedCode) {
    const collected = collect(source);
    const strings = findLeaked(collected.strings, protectedCode, false);
    const names = findLeaked(collected.names, protectedCode, true);
    const api = findLeaked(collected.api, protectedCode, true);
    const total = collected.strings.size + collected.names.size + collected.api.size;
    const leaked = strings.length + names.length + api.length;
    const score = total === 0 ? 100 : Math.max(0, Math.round(100 * (1 - leaked / total)));
    const verdict = score >= 95 ? "clean: no guest literals, identifiers or method names survive"
        : score >= 80 ? "mostly clean: a few short or common tokens survive"
            : score >= 50 ? "leaky: grep-able fragments remain, raise the tier or disable the offending passes"
                : "poor: large parts of the original program are still readable";
    return {
        guestStrings: { total: collected.strings.size, leaked: strings.length, samples: strings.slice(0, 8) },
        guestNames: { total: collected.names.size, leaked: names.length, samples: names.slice(0, 8) },
        apiSurface: { total: collected.api.size, leaked: api.length, samples: api.slice(0, 8) },
        score,
        verdict,
    };
}
//# sourceMappingURL=leakaudit.js.map