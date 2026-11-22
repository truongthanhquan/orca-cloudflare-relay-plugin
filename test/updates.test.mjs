import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundledRelayInfo, compareVersions, evaluateRelayUpdate, shouldAutoInstall } from '../src/updates.mjs'

test('compares versions numerically', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1)
  assert.equal(compareVersions('v2.3.0', '2.3.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
})

test('update-manifest.json (read only by versions before 2.6.0) stays in step with this release', async () => {
  const legacy = JSON.parse(await readFile(new URL('../update-manifest.json', import.meta.url), 'utf8'))
  const own = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.equal(legacy.schema, 1)
  assert.equal(legacy.plugin.latest, own.version)
  assert.equal(legacy.relay.latest, bundledRelayInfo().version)
})

test('policies decide which relay updates deploy without asking', () => {
  const optional = { available: true, mandatory: false }
  const required = { available: true, mandatory: true }
  assert.equal(shouldAutoInstall('all', optional), true)
  assert.equal(shouldAutoInstall('mandatory', optional), false)
  assert.equal(shouldAutoInstall('mandatory', required), true)
  assert.equal(shouldAutoInstall('off', required), false)
  assert.equal(shouldAutoInstall('all', { available: false }), false)
})

test('relay updates: newer bundled Worker, or a protocol the bridge no longer speaks', () => {
  const bundled = { version: '1.2.0', protocol: 2 }
  assert.deepEqual(evaluateRelayUpdate({ deployed: { version: '1.1.0', protocol: 2 }, bundled, minProtocol: 2 }), {
    available: true,
    mandatory: false,
    deployed: '1.1.0',
    latest: '1.2.0'
  })
  assert.equal(evaluateRelayUpdate({ deployed: { version: '1.0.0', protocol: 1 }, bundled, minProtocol: 2 }).mandatory, true)
  assert.equal(evaluateRelayUpdate({ deployed: { version: '1.2.0', protocol: 2 }, bundled, minProtocol: 2 }).available, false)
})

function fakeOrca(settings) {
  const handlers = new Map()
  const values = new Map(Object.entries(settings))
  const store = new Map()
  const calls = []
  return {
    handlers,
    calls,
    log: () => {},
    host: { has: () => true, call: async (method) => (calls.push(method), method === 'secrets.protection' ? { status: 'unavailable' } : { ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async () => null, set: async () => { throw new Error('secrets.set must not be reached') }, delete: async () => {} },
    settings: { get: async (key) => (key ? values.get(key) : Object.fromEntries(values)), set: async (k, v) => void values.set(k, v) }
  }
}

test('the plugin never updates itself and makes no network call to check (Orca updates plugins)', async () => {
  const realFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    throw new Error('offline')
  }
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick' })
  activate(orca)
  try {
    const result = await orca.handlers.get('check-updates')()
    assert.equal(result.ok, true)
    assert.equal(result.relay, null)
    assert.equal('plugin' in result, false)
    assert.equal(orca.handlers.has('update-plugin'), false)
    assert.deepEqual(fetched, [])
  } finally {
    deactivate()
    globalThis.fetch = realFetch
  }
})

test('setup stops early with a clear reason when Orca has no OS key store for secrets', async () => {
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'worker' })
  activate(orca)
  try {
    const result = await orca.handlers.get('setup')({ mode: 'worker', apiToken: 'cf-token-for-tests' })
    assert.equal(result.ok, false)
    assert.match(result.error, /OS key store/)
    assert.ok(orca.calls.includes('secrets.protection'))
  } finally {
    deactivate()
  }
})
