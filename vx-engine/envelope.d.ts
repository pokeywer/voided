export type IntegrityMode = "off" | "basic" | "mirror";
export type IntegrityFail = "error" | "silent" | "decoy";
export interface EnvelopeOptions {
    mode?: IntegrityMode;
    failMode?: IntegrityFail;
    seed?: number;
    message?: string;
    recheckProbe?: boolean;
    copies?: number;
    probes?: number;
    decoy?: boolean;
}
export interface EnvelopeResult {
    code: string;
    copies: number;
    bytes: number;
    chunkCount: number;
}
/**
 * Wraps a finished protected script in an integrity envelope: the source is stored as one or two
 * independently keyed copies, each decoded and hash-checked before anything executes.
 */
export declare function wrapWithIntegrity(source: string, options?: EnvelopeOptions): EnvelopeResult;
//# sourceMappingURL=envelope.d.ts.map