export declare const CONTROL_GENERATION_STATE: {
    readonly ACTIVE: 'active';
    readonly ORPHANED: 'orphaned';
    readonly DRAIN_ONLY: 'drain-only';
    readonly FENCED: 'fenced';
    readonly CLOSED: 'closed';
};
export declare const CONTROL_CONTINUITY_LIMITS: {
    readonly orphanGraceMs: number;
    readonly authRefreshMinBeforeExpiryMs: number;
    readonly authRefreshMaxBeforeExpiryMs: number;
    readonly expiredAuthExistingSpliceGraceMs: number;
};
export declare function controlLossDisposition(input: {
    matchingResumeSecret: boolean;
    competingGeneration: boolean;
}): 'rebind' | 'fence-old' | 'orphan-grace';
export declare function mayStartNewRelayWork(state: string, authExpired: boolean): boolean;
export interface RelayAuthIdentity {
    sub: string;
    prof: string;
    org?: string;
    relayHostId: string;
}
export declare function preservesRelayAuthIdentity(previous: RelayAuthIdentity, refreshed: RelayAuthIdentity): boolean;
