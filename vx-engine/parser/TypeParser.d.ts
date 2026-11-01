import type { Token, SourceLocation } from "../tokens.js";
import type { Type, Expression, ReturnType, GenericTypeListWithDefaults } from "../ast/types.js";
export interface TypeParserContext {
    tokens: Token[];
    pos: number;
    parseExpression: () => Expression | null;
    loc: () => SourceLocation;
    mergeLoc: (loc: SourceLocation) => SourceLocation;
}
export declare function parseType(ctx: TypeParserContext): Type | null;
export declare function parseReturnType(ctx: TypeParserContext): ReturnType | null;
export declare function parseGenericTypeListWithDefaults(ctx: TypeParserContext): GenericTypeListWithDefaults | null;
//# sourceMappingURL=TypeParser.d.ts.map