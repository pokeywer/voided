export { lex, Lexer } from "./lexer/Lexer.js";
export { parse, parseWithErrors, Parser } from "./parser/Parser.js";
export { obfuscate, printChunk, printExpression } from "./obfuscator/index.js";
export { compile } from "./vm/Compiler.js";
export { generateVM } from "./vm/vm-gen.js";
export { validate } from "./compiler/LuauCompiler.js";
export { obfuscateLuau, applyEnvChecks } from "./pipeline.js";
export { buildEnvChecks } from "./envchecks.js";
export { repairTopLevelOrder } from "./repair.js";
//# sourceMappingURL=index.js.map