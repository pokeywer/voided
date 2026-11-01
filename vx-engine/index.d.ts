export { lex, Lexer, type LexResult } from "./lexer/Lexer.js";
export { parse, parseWithErrors, Parser, type ParseResult } from "./parser/Parser.js";
export { obfuscate, printChunk, printExpression, type ObfuscatorOptions } from "./obfuscator/index.js";
export type { Token, SourceLocation } from "./tokens.js";
export type { Chunk, Statement, Expression } from "./ast/types.js";
export { compile } from "./vm/Compiler.js";
export type { BytecodeChunk, Constant } from "./vm/bytecode.js";
export { generateVM, type VMGenOptions, type VMGenLevel } from "./vm/vm-gen.js";
export { validate, type ValidationResult, type ValidationError } from "./compiler/LuauCompiler.js";
export { obfuscateLuau, applyEnvChecks, type VxOptions, type VxResult, type VxStats, type VxMode, type VxLevel, type VxPreset } from "./pipeline.js";
export { buildEnvChecks, type EnvCheckOptions, type EnvHost, type EnvFailMode } from "./envchecks.js";
export { repairTopLevelOrder, type RepairResult } from "./repair.js";
//# sourceMappingURL=index.d.ts.map