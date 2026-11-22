export declare const RELAY_ADMISSION_BUDGETS: {
    readonly cloudRunConcurrency: 900;
    readonly maxPreAuthConnections: 45;
    readonly maxPreAuthPerSource: 4;
    readonly maxPreAuthAttemptsPerSourcePerMinute: 30;
    readonly reservedHostControls: 100;
    readonly reservedHostDataSockets: 150;
    readonly maxProcessQueuedBytes: number;
    readonly queuedFrameOverheadBytes: 64;
    readonly spliceLowWaterBytes: number;
    readonly spliceHighWaterBytes: number;
    readonly spliceHardQueuedFrames: 4096;
    readonly spliceHardQueuedBytes: number;
    readonly spliceWedgedTimeoutMs: number;
};
export declare const RELAY_CELL_CONNECTION_HARD_CAPS: readonly [600, 1000, 3000];
export type RelayCellConnectionHardCap = (typeof RELAY_CELL_CONNECTION_HARD_CAPS)[number];
export declare const RELAY_CELL_CONNECTION_HARD_CAP: RelayCellConnectionHardCap;
export declare function isRelayCellConnectionHardCap(value: unknown): value is RelayCellConnectionHardCap;
export declare const RELAY_CELL_ADMISSION_BOUNDS: {
    readonly hardCap: 600;
    readonly socketAdmissionCeiling: number;
    readonly maxUnobservedBound: number;
};
export declare function relayCellAdmissionBounds(hardCap: RelayCellConnectionHardCap): {
    hardCap: RelayCellConnectionHardCap;
    socketAdmissionCeiling: number;
    maxUnobservedBound: number;
};
export declare const RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND: number;
export declare function cellPlacementCeiling(connectionHardCap: RelayCellConnectionHardCap, connectionUnobservedBound: number): number;
export declare function hasAdmissionCapacity(input: {
    totalRequests: number;
    preAuthConnections: number;
    sourcePreAuthConnections: number;
    totalRequestCeiling?: number;
}): boolean;
