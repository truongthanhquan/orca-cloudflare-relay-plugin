export declare const HOST_PROOF_TRANSCRIPT_DOMAIN = "orca-relay-host-proof/v1";
export declare const HOST_CHALLENGE_PLAINTEXT_DOMAIN = "orca-relay-host-challenge/v1";
export declare const HOST_CHALLENGE_BOX_ALGORITHM = "Curve25519-XSalsa20-Poly1305";
export declare const HOST_PROOF_ALGORITHM = "HMAC-SHA-256";
export interface HostProofTranscriptInput {
    relayOrigin: string;
    relayEphemeralPublicKey: Uint8Array;
    challengeNonce: Uint8Array;
    challengeId: string;
    issuedAt: number;
    expiresAt: number;
    userId: string;
    profileId: string;
    organizationId: string;
    relayHostId: string;
    hostPublicKey: Uint8Array;
    assignmentEpoch: number;
    previousGeneration?: number;
    resumeRequested: boolean;
}
export declare function buildHostProofTranscript(input: HostProofTranscriptInput): Uint8Array;
export declare function buildHostChallengePlaintext(transcript: Uint8Array, challengeSecret: Uint8Array): Uint8Array;
export declare function buildHostProofMacInput(transcript: Uint8Array): Uint8Array;
