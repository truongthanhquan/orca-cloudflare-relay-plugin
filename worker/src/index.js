// Orca Cloudflare Relay — a Worker + SQLite Durable Object that relays Orca Mobile to an
// Orca desktop. Runs on the Workers Free plan. No dependencies, no build step.
//
//   phone   ──wss /v1/c/<hostId>──────────────▶ ┐
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
// · Host ids are 128-bit random capabilities; registering one needs RELAY_ADMIN_TOKEN when set.
// · Phone connections are rate limited per IP and capped per host, because to Orca every
//   relayed phone arrives from loopback and Orca's own per-source limits do not apply.
// · The desktop bridge additionally refuses anything but an E2EE v2 handshake.

import { DurableObject } from 'cloudflare:workers'

const RELAY_VERSION = '1.1.0'
/** Bumped when the desktop ⇄ relay contract changes; the plugin refuses older relays. */
const RELAY_PROTOCOL = 2
const HOST_ID = /^[A-Za-z0-9_-]{16,64}$/
const CONN_ID = /^[A-Za-z0-9_-]{8,64}$/
const DATA_WAIT_MS = 15_000
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_PHONES_PER_HOST = 16
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
      if (parts[3] === 'register' && request.method === 'POST') {
        const admin = env.RELAY_ADMIN_TOKEN
        if (admin) {
          const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
          if (!timingSafeEqual(given, admin)) return json({ error: 'unauthorized' }, 401)
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
    if (parts[1] === 'c') return this.acceptPhone(request)
    if (parts[3] === 'register') return this.register(request)
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!(await this.authorized(bearer))) return json({ error: 'unauthorized' }, 401)
    if (parts[3] === 'control') return this.acceptControl(request)
    if (parts[3] === 'data' && CONN_ID.test(parts[4] ?? '')) return this.acceptData(request, parts[4])
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
   * Deploy-button install) the first desktop to register claims the id; later attempts must
   * present the same key.
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

  acceptPhone(request) {
    // No presence oracle: a plain GET reveals nothing about the desktop.
    if (!isUpgrade(request)) return this.upgradeRequired()
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (this.rateLimited(ip)) return json({ error: 'rate_limited' }, 429)
    if (this.ctx.getWebSockets('phone').length >= MAX_PHONES_PER_HOST) return json({ error: 'too_many_connections' }, 503)
    const control = this.ctx.getWebSockets('control')[0]
    if (!control) return json({ error: 'host_offline' }, 503)
    const id = connId()
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, ['phone', `phone:${id}`])
    server.serializeAttachment({ role: 'phone', id })
    this.pending.set(id, { frames: [], bytes: 0 })
    control.send(JSON.stringify({ t: 'open', id }))
    setTimeout(() => {
      if (this.pending.has(id) && this.ctx.getWebSockets(`data:${id}`).length === 0) {
        this.pending.delete(id)
        safeClose(server, 1013, 'desktop did not answer')
      }
    }, DATA_WAIT_MS)
    return new Response(null, { status: 101, webSocket: client })
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
      if (!queue || queue.bytes + size > MAX_PENDING_BYTES) {
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
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, 'relay socket error')
  }
}
