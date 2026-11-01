import type { Token } from "../tokens.js";
import type { LexError } from "./types.js";
export interface LexResult {
    tokens: Token[];
    errors: LexError[];
}
export declare class Lexer {
    private source;
    private pos;
    private tokens;
    private errors;
    constructor(source: string);
    lex(): LexResult;
    private clonePos;
    private loc;
    private peek;
    private advance;
    private skipWhitespaceAndComments;
    private skipComment;
    private readLongBracketStart;
    private skipLongComment;
    private addError;
    private readToken;
    private isLetter;
    private isDigit;
    private isIdentCont;
    private readIdentifierOrKeyword;
    private readNumber;
    private isHexDigit;
    private isBinaryDigit;
    private readShortString;
    private readEscapeSequence;
    private readLongString;
    private readBacktickString;
    private readBacktickStringWithInterpolation;
    private findMatchingBrace;
    private tryReadOperator;
    private readLongBracketStartAt;
    private findLongBracketEnd;
}
export declare function lex(source: string): LexResult;
//# sourceMappingURL=Lexer.d.ts.map