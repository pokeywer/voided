export const KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "export", "false",
    "for", "function", "if", "in", "local", "nil", "not", "or",
    "repeat", "return", "then", "true", "until", "while",
]);
export const SOFT_KEYWORDS = new Set(["type"]);
export const TYPE_KEYWORDS = new Set(["read", "write", "typeof"]);
export const MULTI_CHAR_OPERATORS = [
    "//=", "..=", "...", "//", "..", "->", "::",
    "<=", ">=", "==", "~=", "+=", "-=", "*=", "/=", "%=", "^=",
];
export const SINGLE_CHAR_OPERATORS = "+-*/%^<>=.,;:()[]{}|&?@#";
//# sourceMappingURL=tokens.js.map