import { assertStrictJson } from './strict-json.mjs'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cleanPhoneName,
  newPhoneKey,
  phoneKeyEndpoint,
  phoneListView,
  supportsPhoneKeys,
  unusedKeys
} from '../src/phone-access.mjs'

const WORKER = 'https://orca-relay.alice.workers.dev'
const HOST = 'H'.repeat(22)

test('each phone key is a public id plus a secret, carried in its own address', () => {
  const key = newPhoneKey()
  assert.match(key.id, /^[A-Za-z0-9_-]{12}$/)
  assert.match(key.secret, /^[A-Za-z0-9_-]{22}$/)
  assert.notEqual(newPhoneKey().secret, key.secret)
  assert.equal(phoneKeyEndpoint(WORKER, HOST, key), `wss://orca-relay.alice.workers.dev/v1/c/${HOST}/${key.id}.${key.secret}`)
  assert.equal(supportsPhoneKeys({ protocol: 3 }), true)
  assert.equal(supportsPhoneKeys({ protocol: 2 }), false)
  assert.equal(supportsPhoneKeys(null), false)
})

test('the list shows only keys a phone used, newest first, with the names kept here', () => {
  const remote = {
    phones: [
      { id: 'a', addedAt: 1, firstSeen: 10, lastSeen: 50, connected: 0 },
      { id: 'b', addedAt: 2, firstSeen: 20, lastSeen: 20, connected: 1 },
      { id: 'c', addedAt: 3, firstSeen: null, lastSeen: null, connected: 0 }
    ]
  }
  const view = phoneListView(remote, { a: { name: 'Work iPhone' } })
  assert.deepEqual(view.map((p) => [p.id, p.name, p.connected]), [['b', '', 1], ['a', 'Work iPhone', 0]])
  assert.deepEqual(unusedKeys(remote, { now: 1000, olderThanMs: 100 }), ['c'])
  assert.deepEqual(unusedKeys(remote, { now: 1000, olderThanMs: 100, keep: 'c' }), [], 'the code on screen is kept')
  assert.deepEqual(unusedKeys(remote, { now: 50, olderThanMs: 100 }), [], 'too new: its code may still be scanned')
  assert.equal(cleanPhoneName('  Work\u0000 iPhone  '), 'Work iPhone')
  assert.equal(cleanPhoneName('x'.repeat(80)).length, 40)
  assert.equal(cleanPhoneName(42), '')
})

/** Fake relay Worker with per-phone keys (protocol 3 unless told otherwise). */
function fakeRelay({ protocol = 3 } = {}) {
  const state = { phones: new Map(), legacyAllowed: true, calls: [] }
  state.fetch = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    if (href.startsWith(`${WORKER}/health`)) {
      return new Response(JSON.stringify({ ok: true, service: 'orca-cloudflare-relay', version: protocol >= 3 ? '1.3.0' : '1.2.0', protocol }))
    }
    if (href.includes('update-manifest.json')) throw new Error('offline')
    const match = /\/v1\/hosts\/([^/]+)\/(phones|legacy)(?:\/([^/]+))?$/.exec(href)
    if (!match || protocol < 3) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    assert.equal(init.headers?.authorization, `Bearer ${'k'.repeat(43)}`, 'desktop key in the header')
    const [, , kind, id] = match
    state.calls.push(`${method} ${kind}${id ? `/${id}` : ''}`)
    const ok = (body = {}) => new Response(JSON.stringify({ ok: true, ...body }))
    if (kind === 'legacy') {
      state.legacyAllowed = JSON.parse(init.body).allowed
      return ok()
    }
    if (method === 'GET') {
      return ok({
        phones: [...state.phones].map(([phoneId, p]) => ({ id: phoneId, ...p })),
        legacy: { allowed: state.legacyAllowed, lastSeen: null, connected: 0 }
      })
    }
    if (method === 'PUT') {
      state.phones.set(id, { secret: JSON.parse(init.body).secret, addedAt: Date.now(), firstSeen: null, lastSeen: null, connected: 0 })
      return ok()
    }
    if (method === 'DELETE') {
      state.phones.delete(id)
      return ok()
    }
    throw new Error(`unexpected ${method} ${href}`)
  }
  return state
}

/** WebSocket stand-in: the control socket opens, and tests can push relay messages into it. */
function fakeSockets() {
  const sockets = []
  class FakeWebSocket {
    constructor(url) {
      this.url = String(url)
      this.readyState = 0
      this.listeners = new Map()
      sockets.push(this)
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.emit('open', {})
      }, 5)
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
    }
    emit(type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event)
    }
    send() {}
    close(code = 1000) {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close', { code })
    }
  }
  return { sockets, FakeWebSocket, control: () => sockets.find((s) => s.url.endsWith('/control')) }
}

/** A stand-in `orca` CLI that records the address each pairing code points at. */
async function fakeCli() {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-cli-'))
  const log = join(dir, 'addresses.log')
  const cli = join(dir, 'orca')
  await writeFile(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const address = args[args.indexOf('--address') + 1]
require('node:fs').appendFileSync(${JSON.stringify(log)}, address + '\\n')
console.log(JSON.stringify({ available: true, pairingUrl: 'orca://pair?test', endpoint: address, connectionMode: 'direct' }))
`
  )
  await chmod(cli, 0o755)
  return { cli, addresses: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) }
}

function pluginCopy({ cli, protocol = 3 }) {
  const handlers = new Map()
  const posts = []
  const store = new Map([
    ['worker-relay', { workerUrl: WORKER, hostId: HOST, deployedBy: 'plugin', relayVersion: protocol >= 3 ? '1.3.0' : '1.2.0', relayProtocol: protocol }],
    ['tunnel-enabled', true]
  ])
  const secrets = new Map([['relayHostKey', 'k'.repeat(43)], ['relayAdminToken', 'a'.repeat(43)]])
  const values = new Map(Object.entries({ mode: 'worker', orcaCliPath: cli, localPort: 6768 }))
  return {
    handlers,
    posts,
    store,
    log: () => {},
    host: { call: async () => ({ ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: (name, payload) => posts.push({ name, payload }) },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { assertStrictJson(v); store.set(k, v) }, delete: async (k) => void store.delete(k) },
    secrets: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    settings: { get: async (key) => (key ? values.get(key) : Object.fromEntries(values)), set: async (k, v) => void values.set(k, v) }
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function session({ relay, copy, ws }, fn) {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  globalThis.fetch = relay.fetch
  globalThis.WebSocket = ws.FakeWebSocket
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}${Math.random()}`)
  activate(copy)
  try {
    for (let i = 0; i < 100 && (await copy.handlers.get('status')()).status.state !== 'connected'; i += 1) await wait(10)
    return await fn()
  } finally {
    deactivate()
    globalThis.fetch = realFetch
    globalThis.WebSocket = RealWebSocket
  }
}

test('every pairing code gets its own phone key, and one phone can be removed alone', async () => {
  const relay = fakeRelay()
  const ws = fakeSockets()
  const { cli, addresses } = await fakeCli()
  const copy = pluginCopy({ cli })
  await session({ relay, copy, ws }, async () => {
    const shown = await copy.handlers.get('pair')({ name: 'Work iPhone' })
    assert.equal(shown.ok, true, shown.error)
    assert.equal(shown.phoneKeys, true)
    const [address] = await addresses()
    const [id, secret] = address.split('/').at(-1).split('.')
    assert.equal(address, `wss://orca-relay.alice.workers.dev/v1/c/${HOST}/${id}.${secret}`)
    assert.equal(relay.phones.get(id).secret, secret)
    assert.doesNotMatch(JSON.stringify(shown), new RegExp(secret), 'the phone secret never reaches the panel')
    assert.doesNotMatch(JSON.stringify([...copy.store.values()]), new RegExp(secret), 'nor Orca storage')

    // The phone connects with that key: the relay records it and the panel hides the code.
    relay.phones.get(id).firstSeen = Date.now()
    relay.phones.get(id).connected = 1
    ws.control().emit('message', { data: JSON.stringify({ t: 'open', id: 'connAAAA1', phone: id }) })
    assert.ok(copy.posts.some((p) => p.name === 'pairing-connected'))

    let list = await copy.handlers.get('phones')()
    assert.equal(list.phones.supported, true)
    assert.deepEqual(list.phones.list.map((p) => [p.id, p.name, p.connected]), [[id, 'Work iPhone', 1]])

    // A second code, never used, then a third: the unused key is cleaned up, the paired one kept.
    await copy.handlers.get('pair')({})
    const second = (await addresses())[1].split('/').at(-1).split('.')[0]
    await copy.handlers.get('pair')({})
    await wait(50)
    assert.equal(relay.phones.has(second), false, 'unused key removed')
    assert.equal(relay.phones.has(id), true, 'paired phone kept')

    const renamed = await copy.handlers.get('rename-phone')({ id, name: 'Old iPhone' })
    assert.equal(renamed.phones.list[0].name, 'Old iPhone')

    const removed = await copy.handlers.get('remove-phone')({ id })
    assert.equal(removed.ok, true, removed.error)
    assert.equal(relay.phones.has(id), false)
    assert.deepEqual(removed.phones.list, [])
    assert.equal(copy.store.get('phone-names')?.[id], undefined, 'its name is forgotten')

    const blocked = await copy.handlers.get('set-legacy-access')({ allowed: false })
    assert.equal(blocked.ok, true, blocked.error)
    assert.equal(relay.legacyAllowed, false)
    assert.equal(blocked.phones.legacy.allowed, false)

    // Hiding the code drops its key too, since no phone used it.
    await copy.handlers.get('invalidate-pairing')()
    await wait(50)
    assert.equal(relay.phones.size, 0)
    list = await copy.handlers.get('phones')()
    assert.deepEqual(list.phones.list, [])
  })
})

test('with an older relay Worker, pairing keeps the shared address and the panel asks for Update relay', async () => {
  const relay = fakeRelay({ protocol: 2 })
  const ws = fakeSockets()
  const { cli, addresses } = await fakeCli()
  const copy = pluginCopy({ cli, protocol: 2 })
  await session({ relay, copy, ws }, async () => {
    const shown = await copy.handlers.get('pair')({ name: 'ignored' })
    assert.equal(shown.ok, true, shown.error)
    assert.equal(shown.phoneKeys, false)
    assert.deepEqual(await addresses(), [`wss://orca-relay.alice.workers.dev/v1/c/${HOST}`])
    const list = await copy.handlers.get('phones')()
    assert.deepEqual(list.phones, { supported: false, reason: 'relay-update' })
    const removed = await copy.handlers.get('remove-phone')({ id: 'whatever1' })
    assert.equal(removed.ok, false)
    assert.match(removed.error, /Update relay/)
  })
})

test('a code replaced after a phone used it is reported as used, even when the connect event was missed', async () => {
  const relay = fakeRelay()
  const ws = fakeSockets()
  const { cli, addresses } = await fakeCli()
  const copy = pluginCopy({ cli })
  await session({ relay, copy, ws }, async () => {
    await copy.handlers.get('pair')({})
    const id = (await addresses())[0].split('/').at(-1).split('.')[0]
    // The relay saw the phone, but no 'open' reached this desktop.
    relay.phones.get(id).firstSeen = Date.now()
    await copy.handlers.get('invalidate-pairing')()
    await wait(50)
    const last = copy.posts.filter((p) => p.name === 'pairing-invalidated').at(-1)
    assert.deepEqual(last.payload, { reason: 'hidden', used: true, known: true })
    assert.equal(relay.phones.has(id), true, 'the paired phone keeps its key')

    await copy.handlers.get('pair')({})
    const unused = (await addresses()).at(-1).split('/').at(-1).split('.')[0]
    await copy.handlers.get('invalidate-pairing')()
    await wait(50)
    const next = copy.posts.filter((p) => p.name === 'pairing-invalidated').at(-1)
    assert.deepEqual(next.payload, { reason: 'hidden', used: false, known: true })
    for (let i = 0; i < 50 && relay.phones.has(unused); i += 1) await wait(20)
    assert.equal(relay.phones.has(unused), false, 'an unused key is dropped')
  })
})
