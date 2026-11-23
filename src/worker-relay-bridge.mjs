import { EventEmitter } from 'node:events'

const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 60_000
const MAX_BACKOFF_MS = 60_000
/** Orca's own paired-socket handshake deadline (PAIRED_E2EE_HANDSHAKE_DEADLINE_MS). */
const FIRST_FRAME_TIMEOUT_MS = 10_000
/** Relayed phones reach Orca from loopback, which Orca exempts from its per-source caps. */
export const MAX_RELAYED_PHONES = 16
/** Oldest relay Worker contract this bridge speaks (header auth, no presence oracle). */
export const MIN_RELAY_PROTOCOL = 2
/** Frames buffered for a socket that is still connecting (the local Orca socket opens in ms). */
export const MAX_SPLICE_QUEUE_BYTES = 1024 * 1024

/** wss:// URL for a path on the relay Worker (https origin). */
export function relaySocketUrl(workerUrl, path) {
  const url = new URL(path, workerUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  return url.toString()
}

/** The endpoint phones dial: stable for as long as the Worker and host id exist. */
export function phoneEndpoint(workerUrl, hostId) {
  return relaySocketUrl(workerUrl, `/v1/c/${hostId}`)
}

/**
 * Accepts only an Orca E2EE v2 hello for a direct transport. v2 binds a fresh desktop nonce and
 * the transport context into the session, so recorded relay traffic cannot be replayed; Orca's
 * own cloud relay enforces the same (`requireV2`). Legacy v1 hellos are refused here because
 * Orca would accept them on what looks like a direct socket.
 */
export function isE2EEV2Hello(data) {
  if (typeof data !== 'string' || data.length > 4096) return false
  let hello
  try {
    hello = JSON.parse(data)
  } catch {
    return false
  }
  return (
    hello?.type === 'e2ee_hello' &&
    hello.v === 2 &&
    typeof hello.clientPublicKeyB64 === 'string' &&
    typeof hello.clientNonceB64 === 'string' &&
    hello.context?.protocol === 'orca-mobile-e2ee' &&
    hello.context?.transport === 'direct'
  )
}

function closeCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

function safeClose(ws, code, reason) {
  try {
    if (ws.readyState === 0 || ws.readyState === 1) ws.close(closeCode(code), String(reason ?? '').slice(0, 120))
  } catch {
    // Already closing.
  }
}

/**
 * Pipes WebSocket `a` ⇄ `b`, queueing frames sent before the other side opens and mirroring
 * closes. Frame types (text/binary) are preserved, so Orca's E2EE frames pass unchanged.
 * `initial` frames are delivered to `b` first (e.g. a hello already read from `a`).
 */
export function splice(a, b, { onClose = () => {}, initial = [], maxQueuedBytes = MAX_SPLICE_QUEUE_BYTES } = {}) {
  let closed = false
  const sizeOf = (frame) => (typeof frame === 'string' ? frame.length : frame?.byteLength ?? 0)
  const queues = new Map([[a, { frames: [], bytes: 0 }], [b, { frames: [...initial], bytes: initial.reduce((n, f) => n + sizeOf(f), 0) }]])
  const forward = (to) => (event) => {
    if (to.readyState === 1) return to.send(event.data)
    if (to.readyState !== 0) return
    const queue = queues.get(to)
    queue.bytes += sizeOf(event.data)
    if (queue.bytes > maxQueuedBytes) {
      // A peer flooding before the other side is even connected is not a real client.
      safeClose(a, 4009, 'too much data before the connection opened')
      safeClose(b, 4009, 'too much data before the connection opened')
      return
    }
    queue.frames.push(event.data)
  }
  const flush = (ws) => {
    const queue = queues.get(ws)
    queue.bytes = 0
    for (const frame of queue.frames.splice(0)) ws.send(frame)
  }
  const close = (other) => (event) => {
    safeClose(other, event?.code ?? 1000, event?.reason)
    if (!closed) {
      closed = true
      onClose()
    }
  }
  a.addEventListener('message', forward(b))
  b.addEventListener('message', forward(a))
  a.addEventListener('open', () => flush(a))
  b.addEventListener('open', () => flush(b))
  if (a.readyState === 1) flush(a)
  if (b.readyState === 1) flush(b)
  a.addEventListener('close', close(b))
  b.addEventListener('close', close(a))
  a.addEventListener('error', () => safeClose(b, 1011, 'peer error'))
  b.addEventListener('error', () => safeClose(a, 1011, 'peer error'))
}

/**
 * Keeps the desktop attached to the relay Worker. For each phone the Worker announces, opens a
 * data socket to the Worker, checks the phone's first frame is an E2EE v2 hello, and only then
 * opens a local socket to Orca's mobile server and splices them — to Orca it looks exactly like
 * a phone on the LAN. Emits the same `status` shape as TunnelProcess.
 */
export class WorkerRelayBridge extends EventEmitter {
  constructor({ log = () => {}, WebSocketImpl = globalThis.WebSocket, fetchImpl = (...args) => fetch(...args) } = {}) {
    super()
    this.log = log
    this.WebSocket = WebSocketImpl
    this.fetch = fetchImpl
    this.wanted = null
    this.control = null
    this.connections = new Set()
    this.retry = 0
    this.timers = new Set()
    this.status = { state: 'stopped', mode: 'worker', host: null, port: null, endpoint: null, message: null, phones: 0 }
  }

  setStatus(patch) {
    // `needsSetup` only describes an error state; anything else clears it.
    const needsSetup = patch.state === undefined ? this.status.needsSetup : patch.state === 'error' && patch.needsSetup === true
    this.status = { ...this.status, ...patch, needsSetup }
    this.emit('status', this.status)
  }

  later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  authHeaders(options = this.wanted) {
    return { authorization: `Bearer ${options.hostKey}` }
  }

  socket(options, path) {
    return new this.WebSocket(relaySocketUrl(options.workerUrl, path), { headers: this.authHeaders(options) })
  }

  /** @param {{workerUrl: string, hostId: string, hostKey: string, port: number}} options */
  start(options) {
    this.stop({ silent: true })
    this.wanted = options
    this.retry = 0
    this.setStatus({
      state: 'starting',
      host: new URL(options.workerUrl).host,
      port: options.port,
      endpoint: phoneEndpoint(options.workerUrl, options.hostId),
      message: 'Connecting to your Cloudflare relay…',
      phones: 0
    })
    this.checkRelayVersion(options).then((problem) => {
      if (this.wanted !== options) return
      if (problem) {
        this.wanted = null
        this.setStatus({ state: 'error', message: problem, needsSetup: true })
        return
      }
      this.connect()
    })
  }

  /** Refuses relays deployed by an older plugin (they expect the key in the URL). */
  async checkRelayVersion(options) {
    try {
      const response = await this.fetch(`${options.workerUrl}/health`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (payload?.service !== 'orca-cloudflare-relay') return null // Unreachable or propagating: connect() retries.
      if (!(payload.protocol >= MIN_RELAY_PROTOCOL)) {
        return 'Your relay Worker is out of date. Click "Deploy and connect" to update it (phones stay paired).'
      }
    } catch {
      // Offline: connect() keeps retrying.
    }
    return null
  }

  connect() {
    const options = this.wanted
    if (!options) return
    const path = `/v1/hosts/${options.hostId}/control`
    const ws = this.socket(options, path)
    this.control = ws
    let lastPong = Date.now()
    let pinger = null
    let opened = false
    ws.addEventListener('open', () => {
      opened = true
      this.retry = 0
      this.setStatus({ state: 'connected', message: null })
      pinger = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          this.log('Relay control socket stopped answering; reconnecting.')
          safeClose(ws, 4000, 'keepalive timeout')
          return
        }
        if (ws.readyState === 1) ws.send('ping')
      }, PING_INTERVAL_MS)
    })
    ws.addEventListener('message', (event) => {
      if (event.data === 'pong') {
        lastPong = Date.now()
        return
      }
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      lastPong = Date.now()
      if (message?.t === 'open' && typeof message.id === 'string') {
        // Relay 1.3.0+ says which phone key the connection used (null: the shared address).
        this.emit('phone-open', typeof message.phone === 'string' ? message.phone : null)
        this.openPhone(message.id)
      }
    })
    ws.addEventListener('error', () => {})
    ws.addEventListener('close', (event) => {
      clearInterval(pinger)
      if (this.control !== ws) return
      this.control = null
      if (!this.wanted) return
      if (!opened) {
        this.checkRejected(options, relaySocketUrl(options.workerUrl, path).replace(/^ws/, 'http')).then((rejected) => {
          if (rejected && this.wanted === options) {
            this.wanted = null
            this.setStatus({ state: 'error', message: rejected, needsSetup: true })
          }
        })
      }
      const reason = event.code === 1006 ? 'connection lost' : event.reason || `closed (${event.code})`
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry)
      this.retry += 1
      this.setStatus({ state: 'starting', message: `Relay ${reason}. Reconnecting in ${Math.round(delay / 1000)}s…` })
      this.later(() => this.connect(), delay)
    })
  }

  /** Explains a refused control socket (the upgrade error itself carries no status). */
  async checkRejected(options, httpUrl) {
    try {
      const response = await this.fetch(httpUrl, { cache: 'no-store', headers: this.authHeaders(options) })
      // Only the relay's own JSON answers are final; Cloudflare's error pages (e.g. while a new
      // workers.dev route propagates) are retried.
      const payload = await response.json().catch(() => null)
      if (response.status === 401 && payload?.error === 'unauthorized') {
        return 'The relay does not recognise this desktop. Run setup again.'
      }
      if (response.status === 404 && payload?.error === 'not_found') {
        return 'This URL is not an Orca relay Worker (or it is outdated). Deploy it again.'
      }
    } catch {
      // Offline: keep retrying.
    }
    return null
  }

  openPhone(id) {
    const options = this.wanted
    if (!options || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return
    const remote = this.socket(options, `/v1/hosts/${options.hostId}/data/${id}`)
    remote.binaryType = 'arraybuffer'
    remote.addEventListener('error', () => {})
    if (this.connections.size >= MAX_RELAYED_PHONES) {
      remote.addEventListener('open', () => safeClose(remote, 4029, 'too many relayed connections'))
      return
    }
    const pair = { remote, local: null }
    this.connections.add(pair)
    this.setStatus({ phones: this.connections.size })
    const release = () => {
      if (this.connections.delete(pair)) this.setStatus({ phones: this.connections.size })
    }

    // Read the phone's first frame before Orca sees anything.
    const deadline = setTimeout(() => {
      safeClose(remote, 4008, 'handshake timeout')
      release()
    }, FIRST_FRAME_TIMEOUT_MS)
    const onFirst = (event) => {
      remote.removeEventListener('message', onFirst)
      clearTimeout(deadline)
      if (!isE2EEV2Hello(event.data)) {
        this.log('Refused a relayed connection that did not start an Orca E2EE v2 handshake.')
        safeClose(remote, 4001, 'E2EE v2 required')
        release()
        return
      }
      if (this.wanted !== options) {
        safeClose(remote, 1000, 'relay stopped')
        return
      }
      const local = new this.WebSocket(`ws://127.0.0.1:${options.port}`)
      local.binaryType = 'arraybuffer'
      pair.local = local
      splice(remote, local, { onClose: release, initial: [event.data] })
    }
    remote.addEventListener('message', onFirst)
    remote.addEventListener('close', () => {
      clearTimeout(deadline)
      if (!pair.local) release()
    })
  }

  stop({ silent = false } = {}) {
    this.wanted = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.control) safeClose(this.control, 1000, 'desktop stopped the relay')
    this.control = null
    for (const { remote, local } of this.connections) {
      safeClose(remote, 1000, 'desktop stopped the relay')
      if (local) safeClose(local, 1000, 'relay stopped')
    }
    this.connections.clear()
    if (!silent) this.setStatus({ state: 'stopped', message: null, phones: 0 })
  }
}
