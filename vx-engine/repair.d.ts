export interface RepairResult {
    code: string;
    moved: number;
    note: string;
}
/**
 * The max tier scatters honeypot statements between bootstrap declarations, which can leave a
 * `local X = ...` sitting after the first statement that reads X. Hoist those declarations above
 * their earliest use; every other statement keeps its position.
 */
export declare function repairTopLevelOrder(code: string): RepairResult;
//# sourceMappingURL=repair.d.ts.map