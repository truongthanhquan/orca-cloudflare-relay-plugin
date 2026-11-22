import { EventEmitter } from 'node:events'

const PROBE_INTERVAL_MS = 60_000

/**
 * The address phones should dial, from what the person typed: `wss://` (or `https://`, mapped to
 * wss) with a public hostname. Plain ws/http is refused: Orca Mobile on iOS only allows cleartext
 * on local networks, and a public address must use TLS.
 */
export function normalizeCustomEndpoint(value) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw new Error('Enter the public address, for example wss://orca.example.com')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'wss:') throw new Error('The address must start with wss:// (or https://) — phones need TLS for a public address.')
  if (url.username || url.password || url.hash) throw new Error('The address must not contain a user name, password or #fragment.')
  const text = url.toString()
  return url.pathname === '/' && !url.search ? text.replace(/\/$/, '') : text
}

/** Orca's own web client page, which the mobile server serves on every path prefix's origin. */
export function probeUrl(endpoint) {
  const url = new URL(endpoint)
  url.protocol = 'https:'
  url.pathname = '/web-index.html'
  url.search = ''
  return url.toString()
}

/**
 * "Your own address": the person runs the tunnel or proxy (their own cloudflared service,
 * another provider…). Nothing is started here; the plugin only checks that the address reaches
 * this Orca and uses it for pairing. Emits the same `status` shape as the other transports.
 */
export class CustomEndpoint extends EventEmitter {
  constructor({ fetchImpl = (...args) => fetch(...args) } = {}) {
    super()
    this.fetch = fetchImpl
    this.wanted = null
    this.timer = null
    this.status = { state: 'stopped', mode: 'custom', host: null, port: null, endpoint: null, message: null, needsSetup: false }
  }

  setStatus(patch) {
    const needsSetup = patch.state === undefined ? this.status.needsSetup : patch.state === 'error' && patch.needsSetup === true
    this.status = { ...this.status, ...patch, needsSetup }
    this.emit('status', this.status)
  }

  start({ endpoint, port }) {
    this.stop({ silent: true })
    this.wanted = { endpoint, port }
    this.setStatus({ state: 'starting', endpoint, host: new URL(endpoint).host, port, message: `Checking ${new URL(endpoint).host}…` })
    this.probe()
    this.timer = setInterval(() => this.probe(), PROBE_INTERVAL_MS)
    this.timer.unref?.()
  }

  async probe() {
    const wanted = this.wanted
    if (!wanted) return
    let problem = null
    try {
      const response = await this.fetch(probeUrl(wanted.endpoint), { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) problem = `HTTP ${response.status}`
    } catch (error) {
      problem = error?.cause?.code ?? error?.message ?? 'unreachable'
    }
    if (this.wanted !== wanted) return
    if (problem) {
      this.setStatus({
        state: 'error',
        message: `${new URL(wanted.endpoint).host} does not reach this Orca (${problem}). Make sure your tunnel or proxy forwards to http://127.0.0.1:${wanted.port}.`
      })
    } else if (this.status.state !== 'connected' || this.status.message) {
      this.setStatus({ state: 'connected', message: null })
    }
  }

  stop({ silent = false } = {}) {
    this.wanted = null
    clearInterval(this.timer)
    this.timer = null
    if (!silent) this.setStatus({ state: 'stopped', message: null })
  }
}
