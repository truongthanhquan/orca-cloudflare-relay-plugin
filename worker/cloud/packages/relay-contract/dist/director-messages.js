import { z } from 'zod';
import { Base64Url32ByteSchema, CanonicalHttpsOriginSchema, EpochMsSchema, GenerationSchema, RelayHostIdSchema } from './wire-scalars.js';
import { RelayRegionSchema } from './relay-regions.js';
import { RegionCorrectionRequestSchema, RegionCorrectionResponseSchema } from './region-correction.js';
const SignedAssignmentLeaseSchema = z
    .string()
    .min(1)
    .max(8 * 1024);
export const AssignmentRequestSchema = z
    .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    // Verify client-declared reconnect against durable assignment before fast-lane admission.
    reconnect: z.boolean().optional(),
    preferredRegion: RelayRegionSchema.optional(),
    regionCorrection: RegionCorrectionRequestSchema.optional()
})
    .strict();
export const AssignmentResponseSchema = z
    .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema,
    lease: SignedAssignmentLeaseSchema,
    regionCorrection: RegionCorrectionResponseSchema.optional()
})
    .strict();
export const ResolveRequestSchema = z
    .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    resumeToken: Base64Url32ByteSchema
})
    .strict();
export const ResolveResponseSchema = z
    .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema,
    leaseExpiresAt: EpochMsSchema
})
    .strict();
export const RelayMovedSchema = z
    .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema
})
    .strict();
export function isTrustedNewerMove(input) {
    // Why: cells and stale director responses must never redirect a credential-bearing client.
    return (input.sourceOrigin === input.configuredDirectorOrigin &&
        input.move.assignmentEpoch > input.currentAssignmentEpoch);
}
