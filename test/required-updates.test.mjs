import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRelayUpdate, higherMinimum, requiredMinimum } from '../src/updates.mjs'

test('a minimum counts only when a version meeting it is published, and is never lowered', () => {
  assert.equal(requiredMinimum('2.7.0', '2.7.1'), '2.7.0')
  assert.equal(requiredMinimum('9.0.0', '2.7.1'), null, 'no fix published: never block with no way out')
  assert.equal(requiredMinimum('nonsense', '2.7.1'), null)
  assert.equal(higherMinimum('2.7.0', null), '2.7.0', 'offline keeps the known minimum')
  assert.equal(higherMinimum('2.7.0', '2.6.0'), '2.7.0')
  assert.equal(higherMinimum('2.7.0', '2.8.0'), '2.8.0')
})

test('a relay Worker below its minimum is required; if the bundled one is too, the plugin updates first', () => {
  const deployed = { version: '1.1.0', protocol: 2 }
  const fixed = evaluateRelayUpdate({ deployed, bundled: { version: '1.2.0', protocol: 2 }, minProtocol: 2, minimum: '1.2.0' })
  assert.equal(fixed.mandatory, true)
  assert.equal(fixed.needsPlugin, false)
  const later = evaluateRelayUpdate({ deployed, bundled: { version: '1.2.0', protocol: 2 }, minProtocol: 2, minimum: '1.3.0' })
  assert.equal(later.mandatory, true)
  assert.equal(later.needsPlugin, true)
})

const WORKER = 'https://orca-relay.alice.workers.dev'

/** Fake GitHub release info, Cloudflare API and relay Worker (deployed version changes on redeploy). */
function fakeNetwork({ manifest, deployedVersion = '1.2.0' }) {
  const state = { deployedVersion, deploys: 0 }
  state.fetch = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
    if (href.includes('update-manifest.json')) return new Response(JSON.stringify(manifest))
    if (href.startsWith(`${WORKER}/health`)) {
      return new Response(JSON.stringify({ ok: true, service: 'orca-cloudflare-relay', version: state.deployedVersion, protocol: 2 }))
    }
    if (/\/v1\/hosts\/[^/]+\/register$/.test(href)) return new Response(JSON.stringify({ ok: true }))
    const path = href.replace('https://api.cloudflare.com/client/v4', '')
    if (path.startsWith('/accounts?')) return ok([{ id: 'acct', name: 'Alice' }])
    if (method === 'GET' && path === '/accounts/acct/workers/scripts') return ok([{ id: 'orca-relay' }])
    if (method === 'PUT' && path === '/accounts/acct/workers/scripts/orca-relay') {
      state.deploys += 1
      state.deployedVersion = '1.2.0'
      return ok({ id: 'orca-relay' })
    }
    if (method === 'POST' && path.endsWith('/subdomain')) return ok({ enabled: true })
    if (method === 'GET' && path === '/accounts/acct/workers/subdomain') return ok({ subdomain: 'alice' })
    if (method === 'GET' && path.includes('/settings')) return ok({ bindings: [{ type: 'durable_object_namespace', name: 'RELAY', class_name: 'RelayHost' }] })
    throw new Error(`offline: ${method} ${href}`)
  }
  return state
}

function fakeOrca({ settings = {}, apiToken = null } = {}) {
  const handlers = new Map()
  const store = new Map([
    ['worker-relay', { workerUrl: WORKER, hostId: 'H'.repeat(22), deployedBy: 'plugin', accountId: 'acct', scriptName: 'orca-relay' }],
    ['tunnel-enabled', true]
  ])
  const secrets = new Map([['relayHostKey', 'k'.repeat(43)], ['relayAdminToken', 'a'.repeat(43)], ...(apiToken ? [['cloudflareApiToken', apiToken]] : [])])
  const values = new Map(Object.entries({ mode: 'worker', orcaCliPath: '/nonexistent/orca', keepApiToken: true, localPort: 6768, ...settings }))
  const bar = []
  return {
    handlers,
    store,
    bar,
    log: () => {},
    host: { call: async (method, params) => (method === 'statusBar.update' && bar.push(params), { ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: { get: async (key) => (key ? values.get(key) : Object.fromEntries(values)), set: async (k, v) => void values.set(k, v) }
  }
}

async function session(net, orca, fn) {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  globalThis.fetch = net.fetch
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0 }
    addEventListener() {}
    close() { this.readyState = 3 }
  }
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}${Math.random()}`)
  activate(orca)
  try {
    return await fn()
  } finally {
    deactivate()
    globalThis.fetch = realFetch
    globalThis.WebSocket = RealWebSocket
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

test('a plugin version with a known security problem turns the relay off until it is updated, even offline', async () => {
  const net = fakeNetwork({ manifest: { schema: 1, plugin: { latest: '9.9.9', minimum: '9.0.0', notes: 'Security fix.' } } })
  const orca = fakeOrca()
  await session(net, orca, async () => {
    const result = await orca.handlers.get('check-updates')()
    assert.equal(result.plugin.mandatory, true)
    await orca.handlers.get('start')()
    await settle()
    const status = await orca.handlers.get('status')()
    assert.equal(status.status.state, 'error')
    assert.match(status.status.message, /known security problem/)
    assert.equal(orca.bar.at(-1).text, 'Update required')
    assert.equal(orca.store.get('tunnel-enabled'), true, 'stays on for the person: resumes after the update')
  })
  // Next start with GitHub unreachable: the stored minimum still blocks.
  const offline = { fetch: async () => { throw new Error('offline') } }
  await session(offline, orca, async () => {
    await settle()
    const status = await orca.handlers.get('status')()
    assert.equal(status.status.state === 'connected', false)
    assert.equal(orca.bar.at(-1).text, 'Update required')
  })
})

test('by default nothing deploys by itself: a required relay update waits for Update relay, even with a kept token', async () => {
  const net = fakeNetwork({ manifest: { schema: 1, plugin: { latest: '2.6.1' }, relay: { latest: '1.2.0', minimum: '1.2.0' } }, deployedVersion: '1.1.0' })
  const orca = fakeOrca({ apiToken: 'cf-token-for-tests' })
  await session(net, orca, async () => {
    await orca.handlers.get('check-updates')()
    await settle()
    assert.equal(net.deploys, 0)
    assert.equal(orca.bar.at(-1).text, 'Update required')
  })
})

test('opted in, a required relay Worker update deploys by itself when a token is kept, keeping the relay on', async () => {
  const net = fakeNetwork({ manifest: { schema: 1, plugin: { latest: '2.6.1' }, relay: { latest: '1.2.0', minimum: '1.2.0' } }, deployedVersion: '1.1.0' })
  const orca = fakeOrca({ apiToken: 'cf-token-for-tests', settings: { relayUpdates: 'mandatory' } })
  await session(net, orca, async () => {
    await orca.handlers.get('check-updates')()
    await settle()
    assert.equal(net.deploys, 1)
    const status = await orca.handlers.get('status')()
    assert.notEqual(status.status.state, 'error', status.status.message)
    assert.doesNotMatch(status.status.message ?? '', /known security problem|must be updated/)
    assert.notEqual(orca.bar.at(-1).text, 'Update required')
    assert.equal(orca.store.get('worker-relay').hostId, 'H'.repeat(22), 'same address: phones stay paired')
  })
})

test('without a token, a required relay update keeps the relay off and asks for Update relay', async () => {
  const net = fakeNetwork({ manifest: { schema: 1, plugin: { latest: '2.6.1' }, relay: { latest: '1.2.0', minimum: '1.2.0' } }, deployedVersion: '1.1.0' })
  const orca = fakeOrca()
  await session(net, orca, async () => {
    await orca.handlers.get('check-updates')()
    await orca.handlers.get('start')()
    await settle()
    assert.equal(net.deploys, 0)
    const status = await orca.handlers.get('status')()
    assert.equal(status.status.state, 'error')
    assert.match(status.status.message, /Update relay/)
    assert.equal(orca.bar.at(-1).text, 'Update required')
  })
})
