import { z } from 'zod';
export declare const RelayAuthSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    mode: z.ZodLiteral<"connect">;
    credential: z.ZodString;
}, z.core.$strict>;
export declare const RelayHelloSchema: z.ZodUnion<readonly [z.ZodObject<{
    ok: z.ZodLiteral<false>;
    code: z.ZodUnion<readonly [z.ZodLiteral<4401>, z.ZodLiteral<4404>, z.ZodLiteral<4408>, z.ZodLiteral<4409>, z.ZodLiteral<4429>, z.ZodLiteral<4503>]>;
}, z.core.$strict>, z.ZodObject<{
    ok: z.ZodLiteral<true>;
    credentialKind: z.ZodLiteral<"invite">;
    leaseExpiresAt: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    ok: z.ZodLiteral<true>;
    credentialKind: z.ZodLiteral<"resume">;
    leaseExpiresAt: z.ZodNumber;
    acceptedCredentialVersion: z.ZodNumber;
    acceptedAs: z.ZodEnum<{
        current: "current";
        grace: "grace";
    }>;
    resumeExpiresAt: z.ZodNumber;
    graceExpiresAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>]>;
export declare const DeviceCredentialInstallSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    relayDeviceId: z.ZodString;
    newResumeTokenHash: z.ZodString;
    expectedCurrentHash: z.ZodOptional<z.ZodString>;
    authorization: z.ZodDiscriminatedUnion<[z.ZodObject<{
        mode: z.ZodLiteral<"relay-basis">;
        basisConnId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        mode: z.ZodLiteral<"authenticated-direct">;
        directAuthId: z.ZodString;
    }, z.core.$strict>], "mode">;
}, z.core.$strict>;
export declare const DeviceCredentialInstallStatusSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    relayDeviceId: z.ZodString;
}, z.core.$strict>;
export declare const DeviceResumeConfirmSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    basisConnId: z.ZodString;
}, z.core.$strict>;
export declare const DeviceCredentialInstalledSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    authorizationMode: z.ZodEnum<{
        "authenticated-direct": "authenticated-direct";
        "relay-basis": "relay-basis";
    }>;
    currentVersion: z.ZodNumber;
    resumeExpiresAt: z.ZodNumber;
    graceExpiresAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const DeviceCredentialInstallStatusResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    state: z.ZodLiteral<"not-found">;
}, z.core.$strict>, z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    state: z.ZodLiteral<"committed">;
    result: z.ZodObject<{
        v: z.ZodLiteral<1>;
        reqId: z.ZodString;
        authorizationMode: z.ZodEnum<{
            "authenticated-direct": "authenticated-direct";
            "relay-basis": "relay-basis";
        }>;
        currentVersion: z.ZodNumber;
        resumeExpiresAt: z.ZodNumber;
        graceExpiresAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export declare const DeviceResumeConfirmedSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    reqId: z.ZodString;
    currentVersion: z.ZodNumber;
    acceptedAs: z.ZodEnum<{
        current: "current";
        grace: "grace";
    }>;
    renewed: z.ZodBoolean;
    resumeExpiresAt: z.ZodNumber;
    graceExpiresAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type RelayAuth = z.infer<typeof RelayAuthSchema>;
export type RelayHello = z.infer<typeof RelayHelloSchema>;
export type DeviceCredentialInstall = z.infer<typeof DeviceCredentialInstallSchema>;
export type DeviceCredentialInstalled = z.infer<typeof DeviceCredentialInstalledSchema>;
export type DeviceCredentialInstallStatus = z.infer<typeof DeviceCredentialInstallStatusSchema>;
export type DeviceCredentialInstallStatusResult = z.infer<typeof DeviceCredentialInstallStatusResultSchema>;
export type DeviceResumeConfirm = z.infer<typeof DeviceResumeConfirmSchema>;
export type DeviceResumeConfirmed = z.infer<typeof DeviceResumeConfirmedSchema>;
