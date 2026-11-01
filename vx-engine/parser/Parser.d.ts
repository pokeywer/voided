import type { Token, SourceLocation } from "../tokens.js";
import type { Chunk } from "../ast/types.js";
export declare class Parser {
    private tokens;
    private pos;
    private errors;
    constructor(tokens: Token[]);
    parse(): Chunk;
    getErrors(): {
        message: string;
        loc: SourceLocation;
    }[];
    private loc;
    private peek;
    private isEOF;
    private consume;
    private check;
    private expect;
    private createTypeContext;
    private parseTypeInContext;
    private parseReturnTypeInContext;
    private parseGenericTypeListWithDefaultsInContext;
    private parseStatementOrLast;
    private parseTypeOrTypeFunction;
    private parseTypeStatement;
    private parseExportOrTypeStatement;
    private skipUnknownStatement;
    private isContinueStatement;
    private parseReturn;
    private parseBreak;
    private parseContinue;
    private parseBinding;
    private parseLocalOrLocalFunction;
    private parseLocalFunctionWithAttrs;
    private parseAttributes;
    private parseDo;
    private parseWhile;
    private parseRepeat;
    private parseIf;
    private parseFor;
    private parseFunction;
    private parseFuncName;
    private parseFuncNamePart;
    private parseFunctionGenerics;
    private parseFunctionBody;
    private parseAssignment;
    private parseCompoundAssignment;
    private parseBlock;
    private parsePrefixExp;
    private parsePrefixExpAfterIdentifier;
    private parseSuffixExp;
    private isCall;
    private parseExpression;
    private parseAsexp;
    private parseSimpleExp;
    private parseIfElseExpression;
    private parseStringInterpolation;
    private parseTableConstructor;
    private parseFunctionExpression;
    private parseExpList;
    private mergeLoc;
}
export interface ParseResult {
    ast: Chunk;
    errors: {
        message: string;
        loc: SourceLocation;
    }[];
}
export declare function parse(tokens: Token[]): Chunk;
export declare function parseWithErrors(tokens: Token[]): ParseResult;
//# sourceMappingURL=Parser.d.ts.map