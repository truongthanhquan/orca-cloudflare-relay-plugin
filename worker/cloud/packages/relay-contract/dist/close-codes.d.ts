export declare const RELAY_CLOSE_CODE: {
    readonly BAD_OUTER_CREDENTIAL: 4401;
    readonly HOST_OFFLINE: 4404;
    readonly PEER_DROPPED: 4408;
    readonly WRONG_CELL: 4409;
    readonly LIMIT_EXCEEDED: 4429;
    readonly DRAINING: 4503;
};
export type RelayCloseCode = (typeof RELAY_CLOSE_CODE)[keyof typeof RELAY_CLOSE_CODE];
export declare const RELAY_PHONE_CLOSE_REASON: {
    readonly HOST_ATTACH_TIMEOUT: 'attach-timeout';
};
export type RelayPhoneCloseReason = (typeof RELAY_PHONE_CLOSE_REASON)[keyof typeof RELAY_PHONE_CLOSE_REASON];
