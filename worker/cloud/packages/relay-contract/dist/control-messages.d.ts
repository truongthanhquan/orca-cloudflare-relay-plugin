import { z } from 'zod';
export declare const HostHelloSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    relayHostId: z.ZodString;
    assignmentEpoch: z.ZodNumber;
    hostPublicKeyB64: z.ZodString;
    appVersion: z.ZodString;
    previousGeneration: z.ZodOptional<z.ZodNumber>;
    controlResumeSecret: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const HostChallengeSchema: z.ZodObject<{
    challengeId: z.ZodString;
    relayEphemeralPublicKeyB64: z.ZodString;
    nonceB64: z.ZodString;
    ciphertextB64: z.ZodString;
    expiresAt: z.ZodNumber;
}, z.core.$strict>;
export declare const HostChallengeAckSchema: z.ZodObject<{
    challengeId: z.ZodString;
    proofB64: z.ZodString;
}, z.core.$strict>;
export declare const RELAY_HOST_CAPABILITIES_HEADER = "x-orca-host-capabilities";
export declare const RELAY_ASSIGNMENT_LEASE_HEADER = "x-orca-relay-assignment-lease";
export declare const RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS = "pending-conn-details";
export declare const RELAY_HOST_CAPABILITY_IDLE_REGIONAL_REHOME = "idle-regional-rehome-v1";
export declare const RELAY_HOST_CAPABILITY_CLIENT_KEEPALIVE = "client-keepalive-v1";
export declare const RELAY_CLIENT_KEEPALIVE_FRAME = "{\"type\":\"keepalive\"}";
export declare const RELAY_CLIENT_KEEPALIVE_ACK_FRAME = "{\"type\":\"keepalive-ack\"}";
export declare const KeepaliveOfferSchema: z.ZodObject<{
    type: z.ZodLiteral<"keepalive-offer">;
    v: z.ZodLiteral<1>;
    intervalMs: z.ZodNumber;
}, z.core.$strict>;
export declare function parseRelayHostCapabilities(header: string | string[] | undefined): ReadonlySet<string>;
export declare const HostHelloAckSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    generation: z.ZodNumber;
    controlResumeSecret: z.ZodString;
    leaseExpiresAt: z.ZodNumber;
    activeConnIds: z.ZodArray<z.ZodString>;
    pendingConns: z.ZodArray<z.ZodObject<{
        connId: z.ZodString;
        connTicket: z.ZodString;
        kind: z.ZodOptional<z.ZodEnum<{
            invite: "invite";
            resume: "resume";
        }>>;
        relayDeviceId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ConnectionOpenSchema: z.ZodObject<{
    connId: z.ZodString;
    connTicket: z.ZodString;
    kind: z.ZodEnum<{
        invite: "invite";
        resume: "resume";
    }>;
    relayDeviceId: z.ZodString;
    attachDeadlineMs: z.ZodNumber;
}, z.core.$strict>;
export declare const HostDataAuthSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    connTicket: z.ZodString;
    generation: z.ZodNumber;
}, z.core.$strict>;
export declare const InviteCreateSchema: z.ZodObject<{
    reqId: z.ZodString;
    relayDeviceId: z.ZodString;
}, z.core.$strict>;
export declare const InviteCreatedSchema: z.ZodObject<{
    reqId: z.ZodString;
    inviteToken: z.ZodString;
    expiresAt: z.ZodNumber;
    maxAttempts: z.ZodNumber;
}, z.core.$strict>;
export declare const DeviceRevokeSchema: z.ZodObject<{
    reqId: z.ZodString;
    relayDeviceId: z.ZodString;
}, z.core.$strict>;
export declare const AuthRefreshSchema: z.ZodObject<{
    relayJwt: z.ZodString;
}, z.core.$strict>;
export declare const DrainSchema: z.ZodObject<{
    graceMs: z.ZodNumber;
    recovery: z.ZodLiteral<"resolve-director">;
}, z.core.$strict>;
export declare const HeartbeatSchema: z.ZodObject<{
    t: z.ZodNumber;
}, z.core.$strict>;
export type HostHello = z.infer<typeof HostHelloSchema>;
export type HostChallenge = z.infer<typeof HostChallengeSchema>;
export type HostChallengeAck = z.infer<typeof HostChallengeAckSchema>;
export type HostHelloAck = z.infer<typeof HostHelloAckSchema>;
export type ConnectionOpen = z.infer<typeof ConnectionOpenSchema>;
export type HostDataAuth = z.infer<typeof HostDataAuthSchema>;
export type InviteCreate = z.infer<typeof InviteCreateSchema>;
export type InviteCreated = z.infer<typeof InviteCreatedSchema>;
export type DeviceRevoke = z.infer<typeof DeviceRevokeSchema>;
export type AuthRefresh = z.infer<typeof AuthRefreshSchema>;
export type Drain = z.infer<typeof DrainSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
