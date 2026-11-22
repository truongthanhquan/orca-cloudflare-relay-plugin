import { z } from 'zod';
export declare const AssignmentRequestSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    relayHostId: z.ZodString;
    reconnect: z.ZodOptional<z.ZodBoolean>;
    preferredRegion: z.ZodOptional<z.ZodEnum<{
        "asia-east2": "asia-east2";
        "us-central1": "us-central1";
    }>>;
    regionCorrection: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        v: z.ZodLiteral<1>;
        action: z.ZodLiteral<"issue-window">;
    }, z.core.$strict>, z.ZodObject<{
        v: z.ZodLiteral<1>;
        action: z.ZodLiteral<"report">;
        generation: z.ZodNumber;
        assignmentEpoch: z.ZodNumber;
        policyVersion: z.ZodLiteral<1>;
        outcome: z.ZodLiteral<"conclusive">;
        measurements: z.ZodObject<{
            'us-central1': z.ZodNumber;
            'asia-east2': z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        v: z.ZodLiteral<1>;
        action: z.ZodLiteral<"report">;
        generation: z.ZodNumber;
        assignmentEpoch: z.ZodNumber;
        policyVersion: z.ZodLiteral<1>;
        outcome: z.ZodLiteral<"inconclusive">;
        reason: z.ZodString;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const AssignmentResponseSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    cellUrl: z.ZodString;
    assignmentEpoch: z.ZodNumber;
    lease: z.ZodString;
    regionCorrection: z.ZodOptional<z.ZodObject<{
        v: z.ZodLiteral<1>;
        window: z.ZodOptional<z.ZodObject<{
            generation: z.ZodNumber;
            expiresAt: z.ZodNumber;
            assignmentEpoch: z.ZodNumber;
            incumbentRegion: z.ZodEnum<{
                "asia-east2": "asia-east2";
                "us-central1": "us-central1";
            }>;
            policyVersion: z.ZodLiteral<1>;
        }, z.core.$strict>>;
        reportStatus: z.ZodOptional<z.ZodEnum<{
            accepted: "accepted";
            "basis-changed": "basis-changed";
            duplicate: "duplicate";
            expired: "expired";
            stale: "stale";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ResolveRequestSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    relayHostId: z.ZodString;
    resumeToken: z.ZodString;
}, z.core.$strict>;
export declare const ResolveResponseSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    cellUrl: z.ZodString;
    assignmentEpoch: z.ZodNumber;
    leaseExpiresAt: z.ZodNumber;
}, z.core.$strict>;
export declare const RelayMovedSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    cellUrl: z.ZodString;
    assignmentEpoch: z.ZodNumber;
}, z.core.$strict>;
export declare function isTrustedNewerMove(input: {
    sourceOrigin: string;
    configuredDirectorOrigin: string;
    currentAssignmentEpoch: number;
    move: z.infer<typeof RelayMovedSchema>;
}): boolean;
export type AssignmentRequest = z.infer<typeof AssignmentRequestSchema>;
export type AssignmentResponse = z.infer<typeof AssignmentResponseSchema>;
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
export type RelayMoved = z.infer<typeof RelayMovedSchema>;
