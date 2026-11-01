import type { Chunk } from "../ast/types.js";
export interface ValidationError {
    message: string;
    line?: number;
    column?: number;
    severity: "error" | "warning" | "info";
}
export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    output?: string;
    ast?: Chunk;
    stats: {
        tokens: number;
        statements: number;
        functions: number;
        locals: number;
        globals: string[];
        features: string[];
    };
}
export declare function validate(source: string): ValidationResult;
//# sourceMappingURL=LuauCompiler.d.ts.map