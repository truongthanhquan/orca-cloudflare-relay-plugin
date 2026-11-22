import { z } from 'zod';
import { GenerationSchema, RelayHostIdSchema } from './wire-scalars.js';
export const IdleRegionalRehomeRequestSchema = z
    .object({
    v: z.literal(1),
    attemptId: z.string().uuid(),
    userId: z.string().min(1).max(256),
    relayHostId: RelayHostIdSchema,
    sourceCellId: z.string().min(1).max(128),
    sourceCellIncarnation: z.string().uuid(),
    sourceAssignmentEpoch: GenerationSchema.refine((value) => value > 0),
    sourceGeneration: GenerationSchema.refine((value) => value > 0),
    targetCellId: z.string().min(1).max(128)
})
    .strict();
// Global deferrals repeat the same durable row verdict for every candidate; stop this poll’s POST walk.
export const GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS = [
    'control-closed',
    'budget-closed',
    'concurrency-limit',
    'cohort-closed',
    'fleet-safety'
];
export const IDLE_REGIONAL_REHOME_DEFER_REASONS = [
    ...GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS,
    'candidate-ineligible',
    'host-unsupported',
    'director-safety-stale'
];
export const IdleRegionalRehomeResponseSchema = z
    .object({
    v: z.literal(1),
    outcome: z.enum(['busy', 'committed', 'deferred', 'stale']),
    // Older cells omit reasons; newer unknown reasons decode absent so mixed versions retain the full walk.
    reason: z.enum(IDLE_REGIONAL_REHOME_DEFER_REASONS).optional().catch(undefined)
})
    // Strip unknown fields so optional additions need no synchronized director rollout.
    .strip();
export function isGlobalIdleRegionalRehomeDeferral(reason) {
    return GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS.some((global) => global === reason);
}
