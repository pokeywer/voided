export type EnvHost = "any" | "roblox" | "roblox-clean" | "executor" | "roblox-or-executor" | "standalone";
export type EnvFailMode = "error" | "silent" | "decoy";
export interface EnvCheckOptions {
    enabled?: boolean;
    host?: EnvHost;
    onFail?: EnvFailMode;
    placeIds?: number[];
    jobIds?: string[];
    gameIds?: number[];
    strictInstances?: boolean;
    timingCheck?: boolean;
    timingLimit?: number;
    message?: string;
    seed?: number;
    report?: boolean;
}
export interface ResolvedEnvCheckOptions {
    enabled: boolean;
    host: EnvHost;
    onFail: EnvFailMode;
    strictInstances: boolean;
    timingCheck: boolean;
    timingLimit: number;
    message: string;
    seed: number;
    report: boolean;
    placeIds?: number[];
    jobIds?: string[];
    gameIds?: number[];
}
export declare function resolveEnvCheckOptions(options: EnvCheckOptions): ResolvedEnvCheckOptions;
export interface EnvCheckResult {
    source: string;
    checks: string[];
}
export declare function buildEnvChecks(options: EnvCheckOptions): EnvCheckResult;
//# sourceMappingURL=envchecks.d.ts.map