import { z } from 'zod';
export const RELAY_REGIONS = ['us-central1', 'asia-east2'];
export const RelayRegionSchema = z.enum(RELAY_REGIONS);
export const RELAY_DEFAULT_REGION = 'us-central1';
// Explicit segments must match Terraform; satisfies forces new regions to define metrics or skew-alert denominators silently omit them.
export const RELAY_REGION_METRIC_SEGMENTS = {
    'us-central1': 'UsCentral1',
    'asia-east2': 'AsiaEast2'
};
const RelayProbeOriginSchema = z.string().url().max(2_048).refine(isCanonicalHttpsOrigin);
export const RelayRegionCatalogResponseSchema = z
    .object({
    v: z.literal(1),
    regions: z
        .array(z
        .object({
        region: RelayRegionSchema,
        probeOrigins: z.array(RelayProbeOriginSchema).min(1).max(2)
    })
        .strict())
        .max(RELAY_REGIONS.length)
})
    .strict()
    .superRefine((catalog, context) => {
    const regions = new Set();
    const origins = new Set();
    for (const [regionIndex, entry] of catalog.regions.entries()) {
        if (regions.has(entry.region)) {
            context.addIssue({
                code: 'custom',
                message: 'duplicate relay region',
                path: ['regions', regionIndex, 'region']
            });
        }
        regions.add(entry.region);
        for (const [originIndex, origin] of entry.probeOrigins.entries()) {
            if (origins.has(origin)) {
                context.addIssue({
                    code: 'custom',
                    message: 'duplicate relay probe origin',
                    path: ['regions', regionIndex, 'probeOrigins', originIndex]
                });
            }
            origins.add(origin);
        }
    }
});
function isCanonicalHttpsOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value;
    }
    catch {
        return false;
    }
}
