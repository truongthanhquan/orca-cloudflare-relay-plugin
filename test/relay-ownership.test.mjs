import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const WORKER = 'https://orca-relay.alice.workers.dev'

function fakeOrca({ deployedBy, relayVersion }) {
  const handlers = new Map()
  const bar = []
  const store = new Map([
    ['worker-relay', { workerUrl: WORKER, hostId: 'H'.repeat(22), deployedBy, relayVersion, relayProtocol: 2 }],
    ['tunnel-enabled', true]
  ])
  const secrets = new Map([['relayHostKey', 'k'.repeat(43)]])
  const values = new Map(Object.entries({ mode: 'worker', orcaCliPath: '/nonexistent/orca', localPort: 6768 }))
  return {
    handlers,
    bar,
    store,
    secrets,
    log: () => {},
    host: { call: async (method, params) => (method === 'statusBar.update' && bar.push(params), { ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: { get: async (key) => (key ? values.get(key) : Object.fromEntries(values)), set: async (k, v) => void values.set(k, v) }
  }
}

async function session(orca, fn) {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  globalThis.fetch = async () => { throw new Error('offline') }
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

test('a Deploy-button relay that lets any desktop register stays off until it is updated', async () => {
  const orca = fakeOrca({ deployedBy: 'button', relayVersion: '1.1.0' })
  await session(orca, async () => {
    await orca.handlers.get('start')()
    await settle()
    const { status } = await orca.handlers.get('status')()
    assert.equal(status.state, 'error')
    assert.match(status.message, /other people could use it/)
    assert.equal(orca.bar.at(-1).text, 'Update required')
  })
})

test('plugin-deployed relays always needed the admin secret, so the same version is not blocked', async () => {
  const orca = fakeOrca({ deployedBy: 'plugin', relayVersion: '1.1.0' })
  await session(orca, async () => {
    await orca.handlers.get('start')()
    await settle()
    const { status } = await orca.handlers.get('status')()
    assert.doesNotMatch(status.message ?? '', /other people could use it/)
    assert.notEqual(orca.bar.at(-1).text, 'Update required')
  })
})

test('the owner token for a Deploy-button relay is the one this desktop registers with', async () => {
  const orca = fakeOrca({ deployedBy: 'button', relayVersion: '1.3.1' })
  await session(orca, async () => {
    const first = await orca.handlers.get('owner-token')()
    assert.equal(first.ok, true, first.error)
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(await orca.secrets.get('relayAdminToken'), first.token)
    assert.equal((await orca.handlers.get('owner-token')()).token, first.token, 'stable: the deployed Worker keeps working')
  })
})

test("the Deploy button's placeholder secret is one the Worker refuses as a key", async () => {
  const example = await readFile(new URL('../worker/.dev.vars.example', import.meta.url), 'utf8')
  const placeholder = /^RELAY_ADMIN_TOKEN=(.*)$/m.exec(example)?.[1]
  assert.match(placeholder, /^paste-/)
  const source = await readFile(new URL('../worker/src/index.js', import.meta.url), 'utf8')
  assert.match(source, /!\/\^paste-\/i\.test\(token\)/, 'adminTokenOf rejects the placeholder')
  assert.equal(source.match(/env\.RELAY_ADMIN_TOKEN/g).length, 1, 'read only inside adminTokenOf')
})
