import { z } from 'zod';
import { EpochMsSchema, GenerationSchema, OpaqueIdSchema, RelayHostIdSchema } from './wire-scalars.js';
export const ASSIGNMENT_LIMITS = {
    activityLeaseMs: 90 * 1000,
    dormantTtlMs: 24 * 60 * 60 * 1000,
    migrationLeaseMs: 15 * 60 * 1000
};
export const AssignmentActivitySchema = z
    .object({
    relayHostId: RelayHostIdSchema,
    cellId: OpaqueIdSchema,
    assignmentEpoch: GenerationSchema,
    leaseExpiresAt: EpochMsSchema,
    lastActivityAt: EpochMsSchema,
    reservedControls: z.number().int().nonnegative(),
    reservedSplices: z.number().int().nonnegative(),
    reservedInvites: z.number().int().nonnegative(),
    pendingInstalls: z.number().int().nonnegative(),
    pendingConfirmations: z.number().int().nonnegative(),
    migrationLeases: z.number().int().nonnegative()
})
    .strict();
export function hasAssignmentActivity(record) {
    return (record.reservedControls +
        record.reservedSplices +
        record.reservedInvites +
        record.pendingInstalls +
        record.pendingConfirmations +
        record.migrationLeases >
        0);
}
export function mayNormallyReassign(record, now) {
    return !hasAssignmentActivity(record) && now >= record.lastActivityAt + ASSIGNMENT_LIMITS.dormantTtlMs;
}
export const EvacuationCommitSchema = z
    .object({
    relayHostId: RelayHostIdSchema,
    sourceCellId: OpaqueIdSchema,
    targetCellId: OpaqueIdSchema,
    previousEpoch: GenerationSchema,
    assignmentEpoch: GenerationSchema,
    targetCapacityReserved: z.literal(true)
})
    .strict()
    .refine((move) => move.sourceCellId !== move.targetCellId, 'target cell must differ')
    .refine((move) => move.assignmentEpoch === move.previousEpoch + 1, 'epoch must increment exactly once');
