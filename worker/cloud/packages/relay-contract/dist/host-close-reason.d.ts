export declare const RELAY_HOST_CLOSE_REASON: {
    readonly SIGNED_OUT: 'signed-out';
};
export type RelayHostCloseReason = (typeof RELAY_HOST_CLOSE_REASON)[keyof typeof RELAY_HOST_CLOSE_REASON];
export declare function relayHostCloseReasonFrom(value: unknown): RelayHostCloseReason | null;
