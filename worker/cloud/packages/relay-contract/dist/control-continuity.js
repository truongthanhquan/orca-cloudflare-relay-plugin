export const CONTROL_GENERATION_STATE = {
    ACTIVE: 'active',
    ORPHANED: 'orphaned',
    DRAIN_ONLY: 'drain-only',
    FENCED: 'fenced',
    CLOSED: 'closed'
};
export const CONTROL_CONTINUITY_LIMITS = {
    orphanGraceMs: 30 * 1000,
    authRefreshMinBeforeExpiryMs: 60 * 1000,
    authRefreshMaxBeforeExpiryMs: 120 * 1000,
    expiredAuthExistingSpliceGraceMs: 60 * 1000
};
export function controlLossDisposition(input) {
    if (input.matchingResumeSecret)
        return 'rebind';
    if (input.competingGeneration)
        return 'fence-old';
    return 'orphan-grace';
}
export function mayStartNewRelayWork(state, authExpired) {
    return state === CONTROL_GENERATION_STATE.ACTIVE && !authExpired;
}
export function preservesRelayAuthIdentity(previous, refreshed) {
    return (previous.sub === refreshed.sub &&
        previous.prof === refreshed.prof &&
        previous.org === refreshed.org &&
        previous.relayHostId === refreshed.relayHostId);
}
