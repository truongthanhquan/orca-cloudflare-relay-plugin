import { z } from 'zod';
export declare const RegionMeasurementsSchema: z.ZodObject<{
    'us-central1': z.ZodNumber;
    'asia-east2': z.ZodNumber;
}, z.core.$strict>;
export declare const RegionMeasurementWindowSchema: z.ZodObject<{
    generation: z.ZodNumber;
    expiresAt: z.ZodNumber;
    assignmentEpoch: z.ZodNumber;
    incumbentRegion: z.ZodEnum<{
        "asia-east2": "asia-east2";
        "us-central1": "us-central1";
    }>;
    policyVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const RegionCorrectionRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
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
}, z.core.$strict>]>;
export declare const RegionCorrectionResponseSchema: z.ZodObject<{
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
}, z.core.$strict>;
export type RegionMeasurements = z.infer<typeof RegionMeasurementsSchema>;
export type RegionMeasurementWindow = z.infer<typeof RegionMeasurementWindowSchema>;
export type RegionCorrectionRequest = z.infer<typeof RegionCorrectionRequestSchema>;
export type RegionCorrectionResponse = z.infer<typeof RegionCorrectionResponseSchema>;
