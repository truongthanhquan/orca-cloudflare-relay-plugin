import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { rememberHostId, rememberedHostId } from '../src/relay-identity.mjs'

const WORKER = 'https://orca-relay.alice.workers.dev'

test('the relay identity is remembered per Worker and validated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-id-'))
  assert.equal(await rememberedHostId(WORKER, { dir }), null)
  await rememberHostId(`${WORKER}/`, 'A'.repeat(22), { dir })
  assert.equal(await rememberedHostId(WORKER.toUpperCase(), { dir }), 'A'.repeat(22))
  await rememberHostId(WORKER, 'B'.repeat(22), { dir, ifAbsent: true })
  assert.equal(await rememberedHostId(WORKER, { dir }), 'A'.repeat(22), 'ifAbsent never replaces')
  await rememberHostId(WORKER, 'bad id!', { dir })
  assert.equal(await rememberedHostId(WORKER, { dir }), 'A'.repeat(22))
  assert.equal(await rememberedHostId('https://other.example.workers.dev', { dir }), null)
})

/** Fake Cloudflare API + relay; records every host id registered. */
function fakeCloudflare() {
  const registered = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
    if (href.startsWith(`${WORKER}/health`)) {
      return new Response(JSON.stringify({ ok: true, service: 'orca-cloudflare-relay', version: '1.2.0', protocol: 2 }), { status: 200 })
    }
    const reg = /\/v1\/hosts\/([^/]+)\/register$/.exec(href)
    if (reg && method === 'POST') {
      registered.push(reg[1])
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const path = href.replace('https://api.cloudflare.com/client/v4', '')
    if (path.includes('/tokens/verify')) return ok({ status: 'active' })
    if (path.startsWith('/accounts?')) return ok([{ id: 'acct', name: 'Alice' }])
    if (method === 'GET' && path === '/accounts/acct/workers/scripts') return ok([{ id: 'orca-relay' }])
    if (method === 'PUT' && path === '/accounts/acct/workers/scripts/orca-relay') return ok({ id: 'orca-relay' })
    if (method === 'POST' && path.endsWith('/subdomain')) return ok({ enabled: true })
    if (method === 'GET' && path === '/accounts/acct/workers/subdomain') return ok({ subdomain: 'alice' })
    if (method === 'GET' && path.includes('/workers/scripts/orca-relay/settings')) return ok({ bindings: [{ type: 'durable_object_namespace', name: 'RELAY', class_name: 'RelayHost' }] })
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 400 })
  }
  return { registered, fetchImpl }
}

/** One copy of the plugin: its own Orca storage and secrets (like a separate plugin key). */
function pluginCopy() {
  const handlers = new Map()
  const store = new Map()
  const secrets = new Map()
  const settings = new Map([['mode', 'worker'], ['keepApiToken', true]])
  return {
    handlers,
    store,
    log: () => {},
    host: { call: async () => ({ ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: { get: async (key) => (key ? settings.get(key) : Object.fromEntries(settings)), set: async (k, v) => void settings.set(k, v) }
  }
}

async function withOffline(fetchImpl, fn) {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  globalThis.fetch = fetchImpl
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0 }
    addEventListener() {}
    close() { this.readyState = 3 }
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
    globalThis.WebSocket = RealWebSocket
  }
}

async function run(copy, fn) {
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}${Math.random()}`)
  activate(copy)
  try {
    return await fn()
  } finally {
    deactivate()
  }
}

test('updating the relay Worker, updating the plugin and reinstalling all keep the phone address', async () => {
  process.env.ORCA_CLOUDFLARE_RELAY_STATE_DIR = await mkdtemp(join(tmpdir(), 'orca-cf-state-'))
  const cf = fakeCloudflare()
  await withOffline(cf.fetchImpl, async () => {
    const copy = pluginCopy()
    // First setup.
    await run(copy, async () => {
      const result = await copy.handlers.get('setup')({ mode: 'worker', apiToken: 'cf-token-for-tests' })
      assert.equal(result.ok, true, result.error)
    })
    const first = copy.store.get('worker-relay').hostId
    // Relay Worker update (a redeploy) and a plugin update (a fresh worker process, same storage).
    await run(copy, async () => {
      const result = await copy.handlers.get('update-relay')({})
      assert.equal(result.ok, true, result.error)
    })
    assert.equal(copy.store.get('worker-relay').hostId, first)
    // Reinstall, or another copy of the plugin: empty Orca storage for the plugin.
    const reinstalled = pluginCopy()
    await run(reinstalled, async () => {
      const result = await reinstalled.handlers.get('setup')({ mode: 'worker', apiToken: 'cf-token-for-tests' })
      assert.equal(result.ok, true, result.error)
    })
    assert.equal(reinstalled.store.get('worker-relay').hostId, first)
    assert.deepEqual([...new Set(cf.registered)], [first], 'only ever the one address phones were paired with')
  })
})

test('a copy that registered its own address switches to the one phones were paired with', async () => {
  process.env.ORCA_CLOUDFLARE_RELAY_STATE_DIR = await mkdtemp(join(tmpdir(), 'orca-cf-state-'))
  const cf = fakeCloudflare()
  const paired = 'P'.repeat(22)
  await rememberHostId(WORKER, paired)
  await withOffline(cf.fetchImpl, async () => {
    const stale = pluginCopy()
    stale.store.set('worker-relay', { workerUrl: WORKER, hostId: 'S'.repeat(22), deployedBy: 'plugin' })
    stale.store.set('tunnel-enabled', true)
    await stale.secrets.set('relayHostKey', 'k'.repeat(43))
    await stale.secrets.set('relayAdminToken', 'a'.repeat(43))
    await run(stale, async () => {
      await stale.handlers.get('start')()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    assert.equal(stale.store.get('worker-relay').hostId, paired)
    assert.ok(cf.registered.includes(paired))
  })
})

test('disconnect all phones moves the relay to a new address that nothing switches back from', async () => {
  process.env.ORCA_CLOUDFLARE_RELAY_STATE_DIR = await mkdtemp(join(tmpdir(), 'orca-cf-state-'))
  const old = 'O'.repeat(22)
  await rememberHostId(WORKER, old)
  const registrations = []
  const fetchImpl = async (url, init = {}) => {
    const match = /\/v1\/hosts\/([^/]+)\/register$/.exec(String(url))
    if (match) {
      registrations.push({ hostId: match[1], key: JSON.parse(init.body).key })
      return new Response(JSON.stringify({ ok: true }))
    }
    if (String(url).startsWith(`${WORKER}/health`)) return new Response(JSON.stringify({ ok: true, service: 'orca-cloudflare-relay', version: '1.2.0', protocol: 2 }))
    throw new Error('offline')
  }
  await withOffline(fetchImpl, async () => {
    const copy = pluginCopy()
    copy.store.set('worker-relay', { workerUrl: WORKER, hostId: old, deployedBy: 'plugin' })
    await copy.secrets.set('relayHostKey', 'k'.repeat(43))
    await copy.secrets.set('relayAdminToken', 'a'.repeat(43))
    await run(copy, async () => {
      const result = await copy.handlers.get('disconnect-all-phones')()
      assert.equal(result.ok, true, result.error)
    })
    const fresh = copy.store.get('worker-relay').hostId
    assert.notEqual(fresh, old)
    assert.equal(await rememberedHostId(WORKER), fresh, 'other copies adopt the new address, not the old one')
    const newKey = await copy.secrets.get('relayHostKey')
    assert.notEqual(newKey, 'k'.repeat(43), 'a new desktop key too')
    assert.deepEqual(registrations.find((r) => r.hostId === fresh)?.key, newKey)
    const rekeyed = registrations.find((r) => r.hostId === old)
    assert.ok(rekeyed && rekeyed.key !== newKey && rekeyed.key !== 'k'.repeat(43), 'the old address gets a key nobody holds')
  })
})
