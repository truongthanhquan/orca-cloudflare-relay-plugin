// Mirror src/shared/relay-host-close-reason.ts; record host socket reasons for later phone refusals.
// Unknown/empty reasons, including abrupt 1006 and older peers, mean unknown.
export const RELAY_HOST_CLOSE_REASON = {
    SIGNED_OUT: 'signed-out'
};
const REASONS = Object.values(RELAY_HOST_CLOSE_REASON);
export function relayHostCloseReasonFrom(value) {
    const text = typeof value === 'string' ? value : (value?.toString() ?? '');
    return REASONS.includes(text) ? text : null;
}
