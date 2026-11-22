import { z } from 'zod';
export declare const RELAY_REGIONS: readonly ['us-central1', 'asia-east2'];
export declare const RelayRegionSchema: z.ZodEnum<{
    "asia-east2": "asia-east2";
    "us-central1": "us-central1";
}>;
export type RelayRegion = z.infer<typeof RelayRegionSchema>;
export declare const RELAY_DEFAULT_REGION: RelayRegion;
export declare const RELAY_REGION_METRIC_SEGMENTS: {
    readonly 'us-central1': 'UsCentral1';
    readonly 'asia-east2': 'AsiaEast2';
};
export declare const RelayRegionCatalogResponseSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    regions: z.ZodArray<z.ZodObject<{
        region: z.ZodEnum<{
            "asia-east2": "asia-east2";
            "us-central1": "us-central1";
        }>;
        probeOrigins: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type RelayRegionCatalogResponse = z.infer<typeof RelayRegionCatalogResponseSchema>;
