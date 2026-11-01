export interface SourceLocation {
    start: {
        line: number;
        column: number;
        offset: number;
    };
    end: {
        line: number;
        column: number;
        offset: number;
    };
}
export interface BaseToken {
    type: string;
    loc: SourceLocation;
}
export interface KeywordToken extends BaseToken {
    type: "Keyword";
    value: string;
}
export interface IdentifierToken extends BaseToken {
    type: "Identifier";
    value: string;
}
export interface NumberToken extends BaseToken {
    type: "Number";
    value: string;
    raw: string;
}
export interface StringToken extends BaseToken {
    type: "String";
    value: string;
    raw: string;
}
export interface InterpPartToken extends BaseToken {
    type: "InterpPart";
    value: string;
}
export interface PunctuatorToken extends BaseToken {
    type: "Punctuator";
    value: string;
}
export interface EOFToken extends BaseToken {
    type: "EOF";
}
export type Token = KeywordToken | IdentifierToken | NumberToken | StringToken | InterpPartToken | PunctuatorToken | EOFToken;
export declare const KEYWORDS: Set<string>;
export declare const SOFT_KEYWORDS: Set<string>;
export declare const TYPE_KEYWORDS: Set<string>;
export declare const MULTI_CHAR_OPERATORS: string[];
export declare const SINGLE_CHAR_OPERATORS = "+-*/%^<>=.,;:()[]{}|&?@#";
//# sourceMappingURL=tokens.d.ts.map