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
    needsPlugin: false,
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

test('a newer plugin is only announced, with where to update it in Orca (never installed)', async () => {
  const realFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    if (String(url).includes('update-manifest.json')) {
      return new Response(JSON.stringify({ schema: 1, plugin: { latest: '9.9.9', notes: 'Newer.' } }))
    }
    throw new Error('offline')
  }
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: '/nonexistent/orca' })
  activate(orca)
  try {
    const result = await orca.handlers.get('check-updates')()
    assert.equal(result.ok, true)
    assert.equal(result.plugin.available, true)
    assert.equal(result.plugin.latest, '9.9.9')
    assert.equal(result.plugin.status, 'idle', 'announced, not installed')
    assert.deepEqual(fetched.map((url) => url.replace(/\?.*/, '')), [
      'https://raw.githubusercontent.com/truongthanhquan/orca-cloudflare-relay-plugin/main/update-manifest.json'
    ])
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

/** A stand-in `orca` CLI: lists this plugin and answers `plugin update` as told. */
async function fakeCli(updateAnswer) {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-cli-'))
  const log = join(dir, 'cli.log')
  const path = join(dir, 'orca')
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'plugin' && args[1] === 'list') {
  console.log(JSON.stringify({ ok: true, result: { plugins: [{ pluginKey: 'acme.cloudflare-relay', status: 'running', version: '2.6.1' }] } }))
} else if (args[0] === 'plugin' && args[1] === 'update') {
  const answer = ${JSON.stringify(updateAnswer)}
  console.log(JSON.stringify(answer.body))
  process.exit(answer.code)
}
`
  )
  await chmod(path, 0o755)
  return { path, log }
}

async function withRelease(fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('update-manifest.json')) return new Response(JSON.stringify({ schema: 1, plugin: { latest: '9.9.9', notes: 'Newer.' } }))
    throw new Error('offline')
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

test('Update now runs Orca\'s updater only on click, and reports success', async () => {
  const { readFile } = await import('node:fs/promises')
  const cli = await fakeCli({ code: 0, body: { ok: true, result: { status: 'updated', version: '9.9.9' } } })
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: cli.path })
  activate(orca)
  try {
    await withRelease(async () => {
      const checked = await orca.handlers.get('check-updates')()
      assert.equal(checked.plugin.pluginKey, 'acme.cloudflare-relay')
      assert.doesNotMatch(await readFile(cli.log, 'utf8'), /plugin update/, 'a check never installs')
      const result = await orca.handlers.get('update-plugin')()
      assert.equal(result.updates.plugin.status, 'updated')
      assert.match(await readFile(cli.log, 'utf8'), /plugin update acme\.cloudflare-relay --json/)
    })
  } finally {
    deactivate()
  }
})

test('Update now explains what Orca wants approved instead of failing with its raw text', async () => {
  const cli = await fakeCli({
    code: 3,
    body: { ok: false, error: { code: 'approval_required', message: 'long text', data: { update: { growth: { capabilities: [], contributions: ['settings'] } } } } }
  })
  const { default: activate, deactivate } = await import(`../src/main.mjs?t=${Date.now()}`)
  const orca = fakeOrca({ mode: 'quick', orcaCliPath: cli.path })
  activate(orca)
  try {
    await withRelease(async () => {
      await orca.handlers.get('check-updates')()
      const result = await orca.handlers.get('update-plugin')()
      assert.equal(result.updates.plugin.status, 'approval_required')
      assert.deepEqual(result.updates.plugin.added, ['settings'])
    })
  } finally {
    deactivate()
  }
})
