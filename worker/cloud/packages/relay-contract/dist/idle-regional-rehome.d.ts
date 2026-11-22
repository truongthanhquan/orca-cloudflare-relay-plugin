import { z } from 'zod';
export declare const IdleRegionalRehomeRequestSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    attemptId: z.ZodString;
    userId: z.ZodString;
    relayHostId: z.ZodString;
    sourceCellId: z.ZodString;
    sourceCellIncarnation: z.ZodString;
    sourceAssignmentEpoch: z.ZodNumber;
    sourceGeneration: z.ZodNumber;
    targetCellId: z.ZodString;
}, z.core.$strict>;
export declare const GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS: readonly ['control-closed', 'budget-closed', 'concurrency-limit', 'cohort-closed', 'fleet-safety'];
export declare const IDLE_REGIONAL_REHOME_DEFER_REASONS: readonly ["control-closed", "budget-closed", "concurrency-limit", "cohort-closed", "fleet-safety", "candidate-ineligible", "host-unsupported", "director-safety-stale"];
export declare const IdleRegionalRehomeResponseSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    outcome: z.ZodEnum<{
        busy: "busy";
        committed: "committed";
        deferred: "deferred";
        stale: "stale";
    }>;
    reason: z.ZodCatch<z.ZodOptional<z.ZodEnum<{
        "budget-closed": "budget-closed";
        "candidate-ineligible": "candidate-ineligible";
        "cohort-closed": "cohort-closed";
        "concurrency-limit": "concurrency-limit";
        "control-closed": "control-closed";
        "director-safety-stale": "director-safety-stale";
        "fleet-safety": "fleet-safety";
        "host-unsupported": "host-unsupported";
    }>>>;
}, z.core.$strip>;
export type IdleRegionalRehomeRequest = z.infer<typeof IdleRegionalRehomeRequestSchema>;
export type IdleRegionalRehomeOutcome = z.infer<typeof IdleRegionalRehomeResponseSchema>['outcome'];
export type IdleRegionalRehomeDeferReason = (typeof IDLE_REGIONAL_REHOME_DEFER_REASONS)[number];
export type IdleRegionalRehomeResult = {
    outcome: IdleRegionalRehomeOutcome;
    reason?: IdleRegionalRehomeDeferReason;
};
export type IdleRegionalRehomeCommit = {
    outcome: Exclude<IdleRegionalRehomeOutcome, 'busy'>;
    reason?: IdleRegionalRehomeDeferReason;
};
export type GlobalIdleRegionalRehomeDeferReason = (typeof GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS)[number];
export declare function isGlobalIdleRegionalRehomeDeferral(reason: IdleRegionalRehomeDeferReason | undefined): reason is GlobalIdleRegionalRehomeDeferReason;
