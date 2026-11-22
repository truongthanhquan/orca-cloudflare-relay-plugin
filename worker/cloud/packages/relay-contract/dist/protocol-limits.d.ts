export declare const RELAY_PROTOCOL_LIMITS: {
    readonly firstFrameDeadlineMs: 2000;
    readonly maxHttpBodyBytes: number;
    readonly maxFrameBytes: number;
    readonly maxConnectionsPerHost: 8;
    readonly idleTimeoutMs: number;
    readonly inviteTtlMs: number;
    readonly inviteMaxAttempts: 5;
    readonly inviteReservationLeaseMs: number;
    readonly inviteAttemptCooldownMs: number;
    readonly hostAttachDeadlineMs: number;
    readonly resumeConfirmationDeadlineMs: number;
    readonly resumeTtlMs: number;
    readonly relayTokenTtlMs: number;
    readonly expiredAuthExistingSpliceGraceMs: number;
    readonly controlPingIntervalMs: number;
    readonly controlSilenceTimeoutMs: number;
};
