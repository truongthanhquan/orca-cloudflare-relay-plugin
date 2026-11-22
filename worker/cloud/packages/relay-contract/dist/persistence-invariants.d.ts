import { z } from 'zod';
export declare const INVITE_STATE: {
    readonly AVAILABLE: 'available';
    readonly RESERVED: 'reserved';
    readonly COOLDOWN: 'cooldown';
    readonly CONSUMED: 'consumed';
    readonly EXPIRED: 'expired';
    readonly INVALIDATED: 'invalidated';
};
export declare const InviteRecordSchema: z.ZodObject<{
    relayDeviceId: z.ZodString;
    tokenHash: z.ZodString;
    state: z.ZodEnum<{
        readonly AVAILABLE: 'available';
        readonly RESERVED: 'reserved';
        readonly COOLDOWN: 'cooldown';
        readonly CONSUMED: 'consumed';
        readonly EXPIRED: 'expired';
        readonly INVALIDATED: 'invalidated';
    }>;
    attemptCount: z.ZodNumber;
    maxAttempts: z.ZodNumber;
    expiresAt: z.ZodNumber;
    reservationId: z.ZodOptional<z.ZodString>;
    reservationExpiresAt: z.ZodOptional<z.ZodNumber>;
    cooldownUntil: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type InviteRecord = z.infer<typeof InviteRecordSchema>;
export type InviteEvent = {
    type: 'reserve';
    reservationId: string;
    reservationExpiresAt: number;
} | {
    type: 'attach-failed';
    cooldownUntil: number;
} | {
    type: 'lease-expired';
    cooldownUntil: number;
} | {
    type: 'provision-committed';
} | {
    type: 'direct-install-committed';
} | {
    type: 'transaction-rollback';
} | {
    type: 'cleanup';
};
export declare function transitionInvite(invite: InviteRecord, event: InviteEvent, now: number): InviteRecord;
export declare const PAIRING_RECOVERY_MATRIX: readonly ['direct-commit-ack', 'direct-commit-response-lost', 'direct-no-commit-invite-fallback', 'late-direct-versus-invite-global-key'];
export declare const CredentialInstallIdentitySchema: z.ZodObject<{
    userId: z.ZodString;
    relayHostId: z.ZodString;
    relayDeviceId: z.ZodString;
    reqId: z.ZodString;
}, z.core.$strict>;
export declare const INSTALL_STATUS: {
    readonly NOT_FOUND: 'not-found';
    readonly COMMITTED: 'committed';
};
export declare const INSTALL_TRANSACTION_CONTRACT: {
    readonly idempotencyKeyFields: readonly ['userId', 'relayHostId', 'relayDeviceId', 'reqId'];
    readonly transactionDeadlineMs: number;
    readonly lockAttemptTimeoutMs: number;
    readonly maxDeadlockRetries: 3;
    readonly atomicEffects: readonly ['idempotency-result', 'token-family', 'affected-invites'];
};
export declare function nextCredentialVersion(currentVersion: number | undefined): number;
export declare const TokenFamilySchema: z.ZodObject<{
    currentVersion: z.ZodNumber;
    currentHash: z.ZodString;
    currentExpiresAt: z.ZodNumber;
    graceVersion: z.ZodOptional<z.ZodNumber>;
    graceHash: z.ZodOptional<z.ZodString>;
    graceExpiresAt: z.ZodOptional<z.ZodNumber>;
    revokedAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type ResumeCommitDecision = 'renew-current' | 'return-unchanged-grace' | 'reject-retired' | 'reject-expired' | 'reject-revoked';
export declare function decideResumeCommit(family: z.infer<typeof TokenFamilySchema>, acceptedVersion: number, now: number): ResumeCommitDecision;
