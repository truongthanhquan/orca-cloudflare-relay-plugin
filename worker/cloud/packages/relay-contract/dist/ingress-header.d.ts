export declare const INGRESS_HEADER = "x-orca-ingress";
export declare const INGRESS_MAX_SKEW_SECONDS = 120;
export declare const INGRESS_SECRET_MIN_LENGTH = 32;
export type IngressClaim = {
    name: string;
    origin: string;
    clientIp: string;
};
export declare function signIngressHeader(secret: string, claim: IngressClaim, nowMs?: number): Promise<string>;
export declare function verifyIngressHeader(value: string | null, secrets: readonly string[], nowMs?: number): Promise<IngressClaim | null>;
