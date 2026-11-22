import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bundledRelayInfo,
  compareVersions,
  evaluateRelayUpdate,
  evaluateUpdate,
  parseUpdateManifest,
  shouldAutoInstall,
  updateManifestUrl
} from '../src/updates.mjs'

test('compares versions numerically', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1)
  assert.equal(compareVersions('v2.3.0', '2.3.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
})

test('derives the update manifest URL from the repository', () => {
  assert.equal(
    updateManifestUrl('https://github.com/truongthanhquan/orca-cloudflare-relay-plugin'),
    'https://raw.githubusercontent.com/truongthanhquan/orca-cloudflare-relay-plugin/main/update-manifest.json'
  )
  assert.equal(updateManifestUrl('https://gitlab.com/a/b'), null)
})

test('the published update manifest parses', async () => {
  const manifest = parseUpdateManifest(JSON.parse(await readFile(new URL('../update-manifest.json', import.meta.url), 'utf8')))
  const own = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.plugin.latest, own.version, 'update-manifest.json plugin.latest matches orca-plugin.json')
  assert.equal(manifest.relay.latest, bundledRelayInfo().version, 'relay.latest matches the bundled Worker')
  assert.throws(() => parseUpdateManifest({ schema: 2 }))
})

test('optional vs required plugin updates', () => {
  const section = { latest: '2.4.0', minimum: '2.1.0', notes: 'n' }
  assert.deepEqual(
    { ...evaluateUpdate('2.3.0', section), notes: undefined },
    { available: true, mandatory: false, latest: '2.4.0', minimum: '2.1.0', notes: undefined }
  )
  assert.equal(evaluateUpdate('2.0.5', section).mandatory, true)
  assert.equal(evaluateUpdate('2.4.0', section).available, false)
  assert.equal(evaluateUpdate('2.4.1', section).available, false, 'newer than published (dev build)')
})

test('policies decide what installs without asking', () => {
  const optional = { available: true, mandatory: false }
  const required = { available: true, mandatory: true }
  assert.equal(shouldAutoInstall('all', optional), true)
  assert.equal(shouldAutoInstall('mandatory', optional), false)
  assert.equal(shouldAutoInstall('mandatory', required), true)
  assert.equal(shouldAutoInstall('off', required), false)
  assert.equal(shouldAutoInstall('all', { available: false }), false)
})

test('relay updates: newer bundled Worker, old protocol, published minimum', () => {
  const bundled = { version: '1.2.0', protocol: 2 }
  assert.deepEqual(
    { ...evaluateRelayUpdate({ deployed: { version: '1.1.0', protocol: 2 }, bundled, minProtocol: 2 }), notes: undefined },
    { available: true, mandatory: false, deployed: '1.1.0', latest: '1.2.0', notes: undefined }
  )
  assert.equal(evaluateRelayUpdate({ deployed: { version: '1.0.0', protocol: 1 }, bundled, minProtocol: 2 }).mandatory, true)
  assert.equal(evaluateRelayUpdate({ deployed: { version: '1.1.0', protocol: 2 }, bundled, minProtocol: 2, published: { latest: '1.2.0', minimum: '1.2.0' } }).mandatory, true)
  assert.equal(evaluateRelayUpdate({ deployed: { version: '1.2.0', protocol: 2 }, bundled, minProtocol: 2 }).available, false)
})

/* ---- end to end through activate() with a fake Orca CLI and update manifest ---- */

async function fakeCli(dir, { isDev = false } = {}) {
  const log = join(dir, 'cli.log')
  const path = join(dir, 'orca')
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'plugin' && args[1] === 'list') {
  console.log(JSON.stringify({ ok: true, result: { plugins: [{ pluginKey: 'acme.cloudflare-relay', status: 'running', version: '2.3.0', isDev: ${isDev} }] } }))
} else if (args[0] === 'plugin' && args[1] === 'update') {
  console.log(JSON.stringify({ ok: true, result: { status: 'updated', pluginKey: args[2], version: '9.0.0' } }))
} else {
  console.log(JSON.stringify({ ok: false, error: { message: 'unexpected' } }))
}
`
  )
  await chmod(path, 0o755)
  return { path, log }
}

function fakeOrca(settings) {
  const handlers = new Map()
  const values = new Map(Object.entries(settings))
  const store = new Map()
  return {
    handlers,
    log: () => {},
    host: { call: async () => ({ ok: true }) },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
    commands: { register: () => {} },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    settings: { get: async (key) => (key ? values.get(key) : Object.fromEntries(values)), set: async (k, v) => void values.set(k, v) }
  }
}

async function withManifest(manifest, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    String(url).includes('update-manifest.json') ? new Response(JSON.stringify(manifest)) : realFetch(url)
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

const required = { schema: 1, plugin: { latest: '9.0.0', minimum: '9.0.0', notes: 'security fix' } }

test('a required update installs itself under the default policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-upd-'))
  const cli = await fakeCli(dir)
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: cli.path, pluginUpdates: 'mandatory' })
  activate(orca)
  try {
    const result = await withManifest(required, () => orca.handlers.get('check-updates')())
    assert.equal(result.plugin.mandatory, true)
    assert.equal(result.plugin.status, 'updated')
    assert.match(await readFile(cli.log, 'utf8'), /plugin update acme\.cloudflare-relay --json/)
  } finally {
    deactivate()
  }
})

test('with "ask first", a required update blocks the relay until installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-upd-'))
  const cli = await fakeCli(dir)
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: cli.path, pluginUpdates: 'off' })
  activate(orca)
  try {
    const result = await withManifest(required, () => orca.handlers.get('check-updates')())
    assert.equal(result.plugin.blocking, true)
    assert.doesNotMatch(await readFile(cli.log, 'utf8'), /plugin update/)
    await orca.handlers.get('start')()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const status = await orca.handlers.get('status')()
    assert.equal(status.status.state, 'error')
    assert.match(status.status.message, /required update/)
  } finally {
    deactivate()
  }
})

test('a development copy is never auto-updated or blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-upd-'))
  const cli = await fakeCli(dir, { isDev: true })
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: cli.path, pluginUpdates: 'all' })
  activate(orca)
  try {
    const result = await withManifest(required, () => orca.handlers.get('check-updates')())
    assert.equal(result.plugin.isDev, true)
    assert.equal(result.plugin.blocking, false)
    assert.doesNotMatch(await readFile(cli.log, 'utf8'), /plugin update/)
  } finally {
    deactivate()
  }
})
