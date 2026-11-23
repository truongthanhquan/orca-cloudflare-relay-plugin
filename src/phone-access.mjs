import { randomBytes } from 'node:crypto'
import { relaySocketUrl } from './worker-relay-bridge.mjs'

/** Relay Worker contract that has per-phone keys (relay 1.3.0+). */
export const PHONE_KEYS_PROTOCOL = 3

/** Whether a deployed relay ({ protocol }) can give each phone its own key. */
export function supportsPhoneKeys(relayState) {
  return Number(relayState?.protocol) >= PHONE_KEYS_PROTOCOL
}

/**
 * A new phone key: a public id (the desktop removes the phone by it) and a secret that only the
 * phone keeps, inside the address its pairing code carries. The desktop never stores the secret.
 */
export function newPhoneKey() {
  return { id: randomBytes(9).toString('base64url'), secret: randomBytes(16).toString('base64url') }
}

/** The address one phone dials: `wss://<worker>/v1/c/<hostId>/<id>.<secret>`. */
export function phoneKeyEndpoint(workerUrl, hostId, key) {
  return relaySocketUrl(workerUrl, `/v1/c/${hostId}/${key.id}.${key.secret}`)
}

async function call({ workerUrl, hostId, hostKey, fetchImpl = fetch, timeoutMs = 15_000 }, method, path, body) {
  const response = await fetchImpl(`${workerUrl}/v1/hosts/${hostId}${path}`, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${hostKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    if (payload?.error === 'too_many_phones') throw new Error('This relay already has 64 phones and codes. Remove some first.')
    throw new Error(`The relay answered ${response.status}${payload?.error ? ` (${payload.error})` : ''}.`)
  }
  return payload
}

/** { phones: [{ id, addedAt, firstSeen, lastSeen, connected }], legacy: { allowed, lastSeen, connected } } */
export async function listPhoneKeys(relay) {
  const payload = await call(relay, 'GET', '/phones')
  return {
    phones: Array.isArray(payload.phones) ? payload.phones : [],
    legacy: payload.legacy ?? { allowed: true, lastSeen: null, connected: 0 }
  }
}

export async function addPhoneKey(relay, key) {
  await call(relay, 'PUT', `/phones/${key.id}`, { secret: key.secret })
}

/** Removes a phone key on the relay and closes that phone's open connection. */
export async function removePhoneKey(relay, id) {
  await call(relay, 'DELETE', `/phones/${encodeURIComponent(id)}`)
}

/** Allows or blocks the shared address that phones paired before per-phone keys use. */
export async function setLegacyAccess(relay, allowed) {
  await call(relay, 'PUT', '/legacy', { allowed })
}

/**
 * The phone list the panel shows: the relay's keys (the truth) joined with the names this desktop
 * keeps. Keys whose code was never used are left out (they are cleaned up separately).
 * @param {{ phones: any[] }} remote
 * @param {Record<string, { name?: string }>} names
 */
export function phoneListView(remote, names = {}) {
  return remote.phones
    .filter((phone) => phone.firstSeen)
    .map((phone) => ({
      id: phone.id,
      name: typeof names[phone.id]?.name === 'string' ? names[phone.id].name : '',
      pairedAt: phone.firstSeen,
      lastSeen: phone.lastSeen ?? phone.firstSeen,
      connected: Number(phone.connected) || 0
    }))
    .sort((a, b) => b.pairedAt - a.pairedAt)
}

/**
 * Keys a code was made for that no phone ever used, once that code can no longer be scanned:
 * safe to remove (a phone pairs through its key, so a paired phone always used it).
 */
export function unusedKeys(remote, { now = Date.now(), olderThanMs, keep = null } = {}) {
  return remote.phones.filter((phone) => !phone.firstSeen && phone.id !== keep && now - Number(phone.addedAt) > olderThanMs).map((phone) => phone.id)
}

/** A name the person typed for a phone, made safe to store and show. */
export function cleanPhoneName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : ''
}
