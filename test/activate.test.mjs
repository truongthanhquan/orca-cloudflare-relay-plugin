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
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) },
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
    assert.equal(bar.at(-1).text, 'Cloudflare: set up')
    assert.match(bar.at(-1).tooltip, /not set up yet/)
  } finally {
    deactivate()
  }
})
