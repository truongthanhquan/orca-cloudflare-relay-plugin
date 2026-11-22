// Signed front-door header. A stateless ingress proxy (one hostname per ingress, e.g. the Hong Kong
// one for mainland China hosts) re-originates requests to the relay edge and adds
//   x-orca-ingress: v1 <name> <origin> <client-ip> <unix-seconds> <hmac-sha256 base64url>
// The MAC covers everything before it, under a secret shared by the edge and its ingresses. The
// edge trusts the fields only when the MAC verifies inside the skew window; otherwise it behaves as
// if the header were absent. Both sides use WebCrypto (Node 24 and Workers).
export const INGRESS_HEADER = 'x-orca-ingress';
export const INGRESS_MAX_SKEW_SECONDS = 120;
// Secrets shorter than this are a misconfiguration, not a key.
export const INGRESS_SECRET_MIN_LENGTH = 32;
const NAME = /^[a-z0-9-]{1,32}$/;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;
const keys = new Map();
function hmacKey(secret) {
    let key = keys.get(secret);
    if (!key) {
        key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
        keys.set(secret, key);
    }
    return key;
}
const toBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function isOrigin(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
    }
    catch {
        return false;
    }
}
export async function signIngressHeader(secret, claim, nowMs = Date.now()) {
    const signed = `v1 ${claim.name} ${claim.origin} ${claim.clientIp} ${Math.floor(nowMs / 1000)}`;
    const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(signed));
    return `${signed} ${toBase64Url(mac)}`;
}
// secrets: every accepted secret (current first, then any being rotated out).
export async function verifyIngressHeader(value, secrets, nowMs = Date.now()) {
    if (!value || secrets.length === 0) {
        return null;
    }
    const parts = value.split(' ');
    if (parts.length !== 6 || parts[0] !== 'v1') {
        return null;
    }
    const [, name, origin, clientIp, seconds, mac] = parts;
    if (!NAME.test(name) || !isOrigin(origin) || !IP.test(clientIp) || !/^\d{1,12}$/.test(seconds)) {
        return null;
    }
    if (Math.abs(nowMs / 1000 - Number(seconds)) > INGRESS_MAX_SKEW_SECONDS) {
        return null;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(mac)) {
        return null;
    }
    const data = new TextEncoder().encode(parts.slice(0, 5).join(' '));
    const signature = fromBase64Url(mac);
    for (const secret of secrets) {
        if (await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, data)) {
            return { name, origin, clientIp };
        }
    }
    return null;
}
