export interface AuditReport {
    guestStrings: {
        total: number;
        leaked: number;
        samples: string[];
    };
    guestNames: {
        total: number;
        leaked: number;
        samples: string[];
    };
    apiSurface: {
        total: number;
        leaked: number;
        samples: string[];
    };
    score: number;
    verdict: string;
}
/**
 * Measures how much of the original program is still readable inside the protected file.
 * Score is 100 when nothing survives the grep, lower as strings/identifiers/API names leak.
 */
export declare function auditProtection(source: string, protectedCode: string): AuditReport;
//# sourceMappingURL=leakaudit.d.ts.map