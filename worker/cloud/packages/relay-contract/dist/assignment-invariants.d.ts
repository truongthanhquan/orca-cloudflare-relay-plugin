import { z } from 'zod';
export declare const ASSIGNMENT_LIMITS: {
    readonly activityLeaseMs: number;
    readonly dormantTtlMs: number;
    readonly migrationLeaseMs: number;
};
export declare const AssignmentActivitySchema: z.ZodObject<{
    relayHostId: z.ZodString;
    cellId: z.ZodString;
    assignmentEpoch: z.ZodNumber;
    leaseExpiresAt: z.ZodNumber;
    lastActivityAt: z.ZodNumber;
    reservedControls: z.ZodNumber;
    reservedSplices: z.ZodNumber;
    reservedInvites: z.ZodNumber;
    pendingInstalls: z.ZodNumber;
    pendingConfirmations: z.ZodNumber;
    migrationLeases: z.ZodNumber;
}, z.core.$strict>;
export declare function hasAssignmentActivity(record: z.infer<typeof AssignmentActivitySchema>): boolean;
export declare function mayNormallyReassign(record: z.infer<typeof AssignmentActivitySchema>, now: number): boolean;
export declare const EvacuationCommitSchema: z.ZodObject<{
    relayHostId: z.ZodString;
    sourceCellId: z.ZodString;
    targetCellId: z.ZodString;
    previousEpoch: z.ZodNumber;
    assignmentEpoch: z.ZodNumber;
    targetCapacityReserved: z.ZodLiteral<true>;
}, z.core.$strict>;
