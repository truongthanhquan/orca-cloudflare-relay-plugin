export declare const SPLICE_STATE: {
    readonly PRE_AUTH_ADMITTED: 'pre-auth-admitted';
    readonly CREDENTIAL_LEASE_RESERVED: 'credential-lease-reserved';
    readonly HOST_NOTIFIED: 'host-notified';
    readonly ATTACH_PENDING: 'attach-pending';
    readonly HOST_ATTACHED: 'host-attached';
    readonly CLIENT_ACKNOWLEDGED: 'client-acknowledged';
    readonly SPLICED: 'spliced';
    readonly E2EE_CONFIRMABLE: 'e2ee-confirmable';
    readonly TEARDOWN: 'teardown';
};
export type SpliceState = (typeof SPLICE_STATE)[keyof typeof SPLICE_STATE];
export declare const SPLICE_FORWARD_TRANSITIONS: Readonly<Record<SpliceState, readonly SpliceState[]>>;
export declare function canAdvanceSplice(from: SpliceState, to: SpliceState): boolean;
export declare function mayAcknowledgeClient(state: SpliceState, forwardingHandlersInstalled: boolean): boolean;
