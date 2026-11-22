import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import activate, { deactivate } from '../src/main.mjs'

function fakeOrca() {
  const handlers = new Map()
  const commands = new Map()
  const store = new Map()
  const secrets = new Map()
  const settings = new Map([['mode', 'worker']])
  const logs = []
  return {
    handlers,
    commands,
    logs,
    log: (message) => logs.push(message),
    host: { call: async () => ({ ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: (id, fn) => commands.set(id, fn) },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: {
      get: async (key) => (key ? settings.get(key) : Object.fromEntries(settings)),
      set: async (k, v) => void settings.set(k, v)
    }
  }
}

test('failed start/setup report errors without an unhandled rejection (which kills the worker)', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const orca = fakeOrca()
    activate(orca)
    const started = await orca.handlers.get('start')()
    assert.equal(started.ok, true)
    const failed = await orca.handlers.get('setup')({ mode: 'worker' })
    assert.equal(failed.ok, false)
    assert.match(failed.error, /token/i)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const status = await orca.handlers.get('status')()
    assert.equal(status.status.state, 'error')
    assert.deepEqual(unhandled, [])
  } finally {
    deactivate()
    process.off('unhandledRejection', onUnhandled)
  }
})


test('a fresh install starts in onboarding: not configured, status bar invites setup', async () => {
  const orca = fakeOrca()
  const bar = []
  orca.host.call = async (method, params) => {
    if (method === 'statusBar.update') bar.push(params)
    return { ok: true }
  }
  activate(orca)
  try {
    const snapshot = await orca.handlers.get('status')()
    assert.equal(snapshot.configured, false)
    assert.equal(bar.at(-1).text, 'Set up relay')
    assert.match(bar.at(-1).tooltip, /not set up yet/)
  } finally {
    deactivate()
  }
})

test('token setup deploys, registers and saves state Orca accepts (strict JSON, no undefined)', async () => {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  const registered = []
  // Fake Cloudflare API plus the deployed relay Worker; nothing leaves the machine.
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
    const method = init.method ?? 'GET'
    if (href.startsWith('https://orca-relay.alice.workers.dev/health')) {
      return new Response(JSON.stringify({ ok: true, service: 'orca-cloudflare-relay', version: '1.2.0', protocol: 2 }), { status: 200 })
    }
    if (href.includes('/register') && method === 'POST') {
      registered.push(init.headers?.authorization ? 'with-auth' : 'no-auth')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const path = href.replace('https://api.cloudflare.com/client/v4', '')
    if (path.startsWith('/user/tokens/verify') || path.includes('/tokens/verify')) return ok({ status: 'active' })
    if (path.startsWith('/accounts?')) return ok([{ id: 'acct', name: 'Alice' }])
    if (method === 'GET' && path === '/accounts/acct/workers/scripts') return ok([])
    if (method === 'PUT' && path === '/accounts/acct/workers/scripts/orca-relay') return ok({ id: 'orca-relay' })
    if (method === 'POST' && path.endsWith('/subdomain')) return ok({ enabled: true })
    if (method === 'GET' && path === '/accounts/acct/workers/subdomain') return ok({ subdomain: 'alice' })
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 400 })
  }
  // The bridge would dial the relay after setup; keep it offline.
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0 }
    addEventListener() {}
    close() { this.readyState = 3 }
  }
  const orca = fakeOrca()
  activate(orca)
  try {
    const result = await orca.handlers.get('setup')({ mode: 'worker', apiToken: 'cf-token-for-tests' })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(registered, ['with-auth'])
    const snapshot = await orca.handlers.get('status')()
    assert.equal(snapshot.configured, true)
  } finally {
    deactivate()
    globalThis.fetch = realFetch
    globalThis.WebSocket = RealWebSocket
  }
})
