// Orca Cloudflare Relay — a Worker + SQLite Durable Object that relays Orca Mobile to an
// Orca desktop. Runs on the Workers Free plan. No dependencies, no build step.
//
//   phone   ──wss /v1/c/<hostId>/<phone>──────▶ ┐
//                                               │  RelayHost DO (one per desktop)
//   desktop ──wss /v1/hosts/<hostId>/control──▶ │  · tells the desktop "phone <id> arrived"
//   desktop ──wss /v1/hosts/<hostId>/data/<id>▶ ┘  · splices phone <id> ⇄ data <id>
//
// The relay is a blind pipe: Orca's own end-to-end encryption (keys pinned from the pairing
// QR code) runs inside the phone's WebSocket, so this Worker only ever sees ciphertext.
//
// Security model
// · Desktop sockets authenticate with `Authorization: Bearer <hostKey>` (never in the URL);
//   only a SHA-256 of the key is stored, compared in constant time.
// · Host ids are 128-bit random capabilities. Registering one needs RELAY_ADMIN_TOKEN when set;
//   otherwise (a Deploy-button install) the first desktop to register becomes the Worker's
//   owner and every later registration must present the same owner token, so nobody else can
//   use the Worker as a free relay or burn its quota.
// · Phone connections are rate limited per IP, capped per IP and per host, because to Orca every
//   relayed phone arrives from loopback and Orca's own per-source limits do not apply.
// · The desktop bridge additionally refuses anything but an E2EE v2 handshake.
// · Per-phone access (protocol 3): each pairing code points its phone at its own address,
//   /v1/c/<hostId>/<id>.<secret>. The desktop adds and removes those keys; only a SHA-256 of
//   the secret is stored. Removing one closes that phone's connection and refuses it from then
//   on, without touching the other phones. Phones paired before keys existed use the bare
//   address, which the desktop can block once they have paired again.

import { DurableObject } from 'cloudflare:workers'

const RELAY_VERSION = '1.3.0'
/** Bumped when the desktop ⇄ relay contract changes; the plugin refuses older relays. */
const RELAY_PROTOCOL = 3
const HOST_ID = /^[A-Za-z0-9_-]{16,64}$/
const CONN_ID = /^[A-Za-z0-9_-]{8,64}$/
/** A phone's key in its address: `<id>.<secret>` (the id is public to the desktop, the secret is not). */
const PHONE_ID = /^[A-Za-z0-9_-]{8,32}$/
const PHONE_SECRET = /^[A-Za-z0-9_-]{22,64}$/
/** Phone keys one desktop may hold (paired phones plus codes on screen). */
const MAX_PHONE_KEYS = 64
/** The bare /v1/c/<hostId> address used by phones paired before per-phone keys. */
const LEGACY = 'legacy'
const DATA_WAIT_MS = 15_000
/** Frames a phone may send before the desktop's data socket arrives (just the E2EE hello). */
const MAX_PENDING_BYTES = 64 * 1024
const MAX_PENDING_FRAMES = 16
const MAX_PHONES_PER_HOST = 16
/** One phone needs one socket; a few more cover reconnects and a second device behind one NAT. */
const MAX_PHONES_PER_IP = 4
const PHONE_RATE_WINDOW_MS = 60_000
const PHONE_RATE_PER_IP = 12

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}

function isUpgrade(request) {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Close codes a WebSocket may send; anything else becomes a normal close. */
function sendableCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

function safeClose(ws, code = 1000, reason = '') {
  try {
    ws.close(sendableCode(code), String(reason).slice(0, 120))
  } catch {
    // Already closed.
  }
}

/** Durable Object name holding the Worker owner (not a valid host id, so never a host). */
const OWNER_OBJECT = 'worker-owner'

function bearerOf(request) {
  return (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
}

function connId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'health')) {
      return json({ ok: true, service: 'orca-cloudflare-relay', version: RELAY_VERSION, protocol: RELAY_PROTOCOL })
    }
    if (parts[0] !== 'v1') return json({ error: 'not_found' }, 404)

    // Phone: /v1/c/<hostId>[/...]
    if (parts[1] === 'c' && HOST_ID.test(parts[2] ?? '')) {
      return env.RELAY.get(env.RELAY.idFromName(parts[2])).fetch(request)
    }

    // Desktop: /v1/hosts/<hostId>/(register|control|data/<connId>)
    if (parts[1] === 'hosts' && HOST_ID.test(parts[2] ?? '')) {
      if (parts[3] === 'register') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
        const admin = env.RELAY_ADMIN_TOKEN
        if (admin) {
          if (!timingSafeEqual(bearerOf(request), admin)) return json({ error: 'unauthorized' }, 401)
        } else {
          // No admin secret (Deploy button): the first registering desktop claims the Worker.
          const owner = await env.RELAY.get(env.RELAY.idFromName(OWNER_OBJECT)).fetch('https://owner/claim', {
            method: 'POST',
            headers: { authorization: request.headers.get('authorization') ?? '' }
          })
          if (!owner.ok) return owner
        }
      }
      return env.RELAY.get(env.RELAY.idFromName(parts[2])).fetch(request)
    }
    return json({ error: 'not_found' }, 404)
  }
}

export class RelayHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.env = env
    /** connId → queued phone frames until the desktop's data socket arrives (memory only). */
    this.pending = new Map()
    /** ip → recent phone connection timestamps (memory only; resets if the object sleeps). */
    this.recent = new Map()
    // Keepalives from the desktop are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request) {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'owner' && url.pathname === '/claim') return this.claimOwner(request)
    if (parts[1] === 'c') return this.acceptPhone(request)
    if (parts[3] === 'register') return this.register(request)
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!(await this.authorized(bearer))) return json({ error: 'unauthorized' }, 401)
    if (parts[3] === 'control') return this.acceptControl(request)
    if (parts[3] === 'data' && CONN_ID.test(parts[4] ?? '')) return this.acceptData(request, parts[4])
    if (parts[3] === 'phones') return this.managePhones(request, parts[4])
    if (parts[3] === 'legacy' && request.method === 'PUT') return this.setLegacy(request)
    return json({ error: 'not_found' }, 404)
  }

  async authorized(key) {
    if (typeof key !== 'string' || key.length < 32) return false
    const stored = await this.ctx.storage.get('keyHash')
    return typeof stored === 'string' && timingSafeEqual(stored, await sha256(key))
  }

  /**
   * Binds this host id to the desktop's secret key. With RELAY_ADMIN_TOKEN set (the plugin's
   * own deploy sets it) only the admin may register, and may re-register. Without it (a
   * Deploy-button install) the caller has already proven it holds the Worker's owner token,
   * and an id, once claimed, can only be re-registered with the same key.
   */
  async register(request) {
    const body = await request.json().catch(() => null)
    const key = body?.key
    if (typeof key !== 'string' || key.length < 32 || key.length > 256) return json({ error: 'invalid_key' }, 400)
    const hash = await sha256(key)
    const stored = await this.ctx.storage.get('keyHash')
    if (stored && !this.env.RELAY_ADMIN_TOKEN && !timingSafeEqual(stored, hash)) {
      return json({ error: 'host_id_taken' }, 409)
    }
    await this.ctx.storage.put('keyHash', hash)
    return json({ ok: true })
  }

  /**
   * Runs only in the dedicated owner object. The first owner token presented claims the Worker;
   * later claims must present the same token. Only its SHA-256 is stored.
   */
  async claimOwner(request) {
    const token = bearerOf(request)
    if (token.length < 32 || token.length > 256) return json({ error: 'owner_token_required' }, 401)
    const hash = await sha256(token)
    const stored = await this.ctx.storage.get('ownerHash')
    if (!stored) {
      await this.ctx.storage.put('ownerHash', hash)
      return json({ ok: true, claimed: true })
    }
    if (!timingSafeEqual(stored, hash)) return json({ error: 'owned_by_another_desktop' }, 403)
    return json({ ok: true })
  }

  upgradeRequired() {
    return json({ error: 'websocket_upgrade_required' }, 426)
  }

  acceptControl(request) {
    if (!isUpgrade(request)) return this.upgradeRequired()
    for (const old of this.ctx.getWebSockets('control')) safeClose(old, 4000, 'replaced by a newer desktop connection')
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, ['control'])
    server.serializeAttachment({ role: 'control' })
    server.send(JSON.stringify({ t: 'hello', version: RELAY_VERSION }))
    return new Response(null, { status: 101, webSocket: client })
  }

  /** True when this IP opened too many phone connections in the last minute. */
  rateLimited(ip) {
    const now = Date.now()
    const recent = (this.recent.get(ip) ?? []).filter((at) => now - at < PHONE_RATE_WINDOW_MS)
    recent.push(now)
    this.recent.set(ip, recent)
    if (this.recent.size > 1000) {
      for (const [key, times] of this.recent) if (!times.some((at) => now - at < PHONE_RATE_WINDOW_MS)) this.recent.delete(key)
    }
    return recent.length > PHONE_RATE_PER_IP
  }

  /** Which phone key an address carries: a stored key id, LEGACY, or null when refused. */
  async accessFor(segment) {
    if (segment === undefined) return (await this.ctx.storage.get('legacyBlocked')) === true ? null : LEGACY
    const dot = segment.indexOf('.')
    const id = segment.slice(0, dot)
    const secret = segment.slice(dot + 1)
    if (dot < 0 || !PHONE_ID.test(id) || !PHONE_SECRET.test(secret)) return null
    const phone = await this.ctx.storage.get(`phone:${id}`)
    return phone && timingSafeEqual(phone.secretHash, await sha256(secret)) ? id : null
  }

  /** Records when a phone key was first and last used (shown to the desktop, never to phones). */
  async touch(access) {
    const now = Date.now()
    if (access === LEGACY) return this.ctx.storage.put('legacyLastSeen', now)
    const phone = await this.ctx.storage.get(`phone:${access}`)
    if (phone) await this.ctx.storage.put(`phone:${access}`, { ...phone, firstSeen: phone.firstSeen ?? now, lastSeen: now })
  }

  async acceptPhone(request) {
    // No presence oracle: a plain GET reveals nothing about the desktop.
    if (!isUpgrade(request)) return this.upgradeRequired()
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (this.rateLimited(ip)) return json({ error: 'rate_limited' }, 429)
    const parts = new URL(request.url).pathname.split('/').filter(Boolean)
    if (parts.length > 4) return json({ error: 'not_found' }, 404)
    const access = await this.accessFor(parts[3])
    if (!access) return json({ error: 'phone_not_allowed' }, 403)
    const phones = this.ctx.getWebSockets('phone')
    if (phones.length >= MAX_PHONES_PER_HOST) return json({ error: 'too_many_connections' }, 503)
    if (phones.filter((ws) => ws.deserializeAttachment()?.ip === ip).length >= MAX_PHONES_PER_IP) {
      return json({ error: 'too_many_connections' }, 429)
    }
    const control = this.ctx.getWebSockets('control')[0]
    if (!control) return json({ error: 'host_offline' }, 503)
    const id = connId()
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, ['phone', `phone:${id}`, `access:${access}`])
    server.serializeAttachment({ role: 'phone', id, ip, access })
    this.pending.set(id, { frames: [], bytes: 0 })
    await this.touch(access)
    control.send(JSON.stringify({ t: 'open', id, phone: access === LEGACY ? null : access }))
    setTimeout(() => {
      if (this.pending.has(id) && this.ctx.getWebSockets(`data:${id}`).length === 0) {
        this.pending.delete(id)
        safeClose(server, 1013, 'desktop did not answer')
      }
    }, DATA_WAIT_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Phone sockets open right now for one key. */
  connectedCount(access) {
    return this.ctx.getWebSockets(`access:${access}`).length
  }

  /** Closes every open connection of one key (its desktop side closes with it). */
  disconnect(access, reason) {
    for (const ws of this.ctx.getWebSockets(`access:${access}`)) {
      const attachment = ws.deserializeAttachment()
      const peer = this.peerOf(attachment)
      safeClose(ws, 4003, reason)
      if (peer) safeClose(peer, 4003, reason)
      if (attachment?.id) this.pending.delete(attachment.id)
    }
  }

  /**
   * Desktop only (already authorised): GET lists the phone keys, PUT <id> {secret} adds one,
   * DELETE <id> removes one and closes its connections.
   */
  async managePhones(request, id) {
    if (request.method === 'GET' && id === undefined) {
      const stored = await this.ctx.storage.list({ prefix: 'phone:' })
      const phones = [...stored].map(([key, phone]) => {
        const phoneId = key.slice('phone:'.length)
        return { id: phoneId, addedAt: phone.addedAt, firstSeen: phone.firstSeen ?? null, lastSeen: phone.lastSeen ?? null, connected: this.connectedCount(phoneId) }
      })
      const legacy = {
        allowed: (await this.ctx.storage.get('legacyBlocked')) !== true,
        lastSeen: (await this.ctx.storage.get('legacyLastSeen')) ?? null,
        connected: this.connectedCount(LEGACY)
      }
      return json({ ok: true, phones, legacy })
    }
    if (!PHONE_ID.test(id ?? '')) return json({ error: 'invalid_phone' }, 400)
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null)
      if (!PHONE_SECRET.test(body?.secret ?? '')) return json({ error: 'invalid_secret' }, 400)
      const existing = await this.ctx.storage.get(`phone:${id}`)
      if (existing) return json({ error: 'phone_exists' }, 409)
      const count = (await this.ctx.storage.list({ prefix: 'phone:' })).size
      if (count >= MAX_PHONE_KEYS) return json({ error: 'too_many_phones' }, 409)
      await this.ctx.storage.put(`phone:${id}`, { secretHash: await sha256(body.secret), addedAt: Date.now(), firstSeen: null, lastSeen: null })
      return json({ ok: true })
    }
    if (request.method === 'DELETE') {
      const existed = await this.ctx.storage.delete(`phone:${id}`)
      this.disconnect(id, 'removed by the desktop')
      return json({ ok: true, removed: existed })
    }
    return json({ error: 'method_not_allowed' }, 405)
  }

  /** Desktop only: allow or block the bare address of phones paired before per-phone keys. */
  async setLegacy(request) {
    const body = await request.json().catch(() => null)
    if (typeof body?.allowed !== 'boolean') return json({ error: 'invalid_body' }, 400)
    await this.ctx.storage.put('legacyBlocked', !body.allowed)
    if (!body.allowed) this.disconnect(LEGACY, 'blocked by the desktop')
    return json({ ok: true, allowed: body.allowed })
  }

  acceptData(request, id) {
    if (!isUpgrade(request)) return this.upgradeRequired()
    const phone = this.ctx.getWebSockets(`phone:${id}`)[0]
    if (!phone) return json({ error: 'phone_gone' }, 410)
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, ['data', `data:${id}`])
    server.serializeAttachment({ role: 'data', id })
    const queued = this.pending.get(id)
    this.pending.delete(id)
    for (const frame of queued?.frames ?? []) server.send(frame)
    return new Response(null, { status: 101, webSocket: client })
  }

  peerOf(attachment) {
    if (attachment?.role === 'phone') return this.ctx.getWebSockets(`data:${attachment.id}`)[0] ?? null
    if (attachment?.role === 'data') return this.ctx.getWebSockets(`phone:${attachment.id}`)[0] ?? null
    return null
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment()
    if (attachment?.role === 'control') return
    const peer = this.peerOf(attachment)
    if (peer) {
      peer.send(message)
      return
    }
    if (attachment?.role === 'phone') {
      const queue = this.pending.get(attachment.id)
      const size = typeof message === 'string' ? message.length : message.byteLength
      if (!queue || queue.bytes + size > MAX_PENDING_BYTES || queue.frames.length >= MAX_PENDING_FRAMES) {
        safeClose(ws, 1013, 'desktop not connected')
        return
      }
      queue.frames.push(message)
      queue.bytes += size
    }
  }

  async webSocketClose(ws, code, reason) {
    // Complete the close handshake so the other end sees `close` promptly.
    safeClose(ws, code, reason)
    const attachment = ws.deserializeAttachment()
    if (attachment?.id) this.pending.delete(attachment.id)
    const peer = this.peerOf(attachment)
    if (peer) safeClose(peer, code, reason)
    if (attachment?.role === 'phone' && attachment.access) await this.touch(attachment.access).catch(() => {})
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, 'relay socket error')
  }
}
