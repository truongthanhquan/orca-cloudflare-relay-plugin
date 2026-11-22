import { z } from 'zod';
export declare const ConfirmableResumeTupleSchema: z.ZodObject<{
    basisConnId: z.ZodString;
    owningControlGeneration: z.ZodNumber;
    relayDeviceId: z.ZodString;
    acceptedCredentialVersion: z.ZodNumber;
    acceptedAs: z.ZodEnum<{
        current: "current";
        grace: "grace";
    }>;
    confirmDeadline: z.ZodNumber;
}, z.core.$strict>;
export declare const RESUME_CONFIRMATION_COMMIT_OUTCOME: {
    readonly RENEW_CURRENT: 'renew-current';
    readonly RETURN_UNCHANGED_GRACE: 'return-unchanged-grace';
    readonly REJECT_RETIRED: 'reject-retired';
    readonly REJECT_EXPIRED: 'reject-expired';
    readonly REJECT_REVOKED: 'reject-revoked';
};
export type ConfirmableResumeTuple = z.infer<typeof ConfirmableResumeTupleSchema>;
