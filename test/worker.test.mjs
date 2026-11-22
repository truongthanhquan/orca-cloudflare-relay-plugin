import assert from 'node:assert/strict'
import test from 'node:test'
import { createCloudflareClient } from '../src/cloudflare-api.mjs'
import {
  TOKEN_TEMPLATE_URL,
  deployRelayWorker,
  normalizeWorkerUrl,
  validWorkerName
} from '../src/worker-deploy.mjs'
import { isE2EEV2Hello, phoneEndpoint, relaySocketUrl } from '../src/worker-relay-bridge.mjs'

function fakeApi({ scripts = [], subdomain = 'alice', rejectMigrationOnce = false } = {}) {
  const calls = []
  let migrationRejected = false
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    const method = init.method ?? 'GET'
    const call = { method, path }
    if (init.body instanceof FormData) {
      call.metadata = JSON.parse(await init.body.get('metadata').text())
      call.source = await init.body.get('index.js').text()
    } else if (init.body) call.body = JSON.parse(init.body)
    calls.push(call)
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
    const fail = (message) => new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status: 400 })
    if (path.startsWith('/accounts?')) return ok([{ id: 'acct', name: 'Alice' }])
    if (method === 'GET' && path === '/accounts/acct/workers/scripts') return ok(scripts)
    if (method === 'PUT' && path === '/accounts/acct/workers/scripts/orca-relay') {
      if (rejectMigrationOnce && call.metadata.migrations && !migrationRejected) {
        migrationRejected = true
        return fail('Migration tag precondition failed')
      }
      return ok({ id: 'orca-relay' })
    }
    if (method === 'POST' && path.endsWith('/subdomain')) return ok({ enabled: true })
    if (method === 'GET' && path === '/accounts/acct/workers/subdomain') return subdomain ? ok({ subdomain }) : fail('no subdomain')
    if (method === 'PUT' && path === '/accounts/acct/workers/subdomain') return ok({ subdomain: call.body.subdomain })
    return fail(`unexpected ${method} ${path}`)
  }
  return { calls, fetchImpl, request: createCloudflareClient('tok', fetchImpl) }
}

test('deploys the relay Worker with a SQLite Durable Object and admin secret', async () => {
  const api = fakeApi()
  const result = await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'export default {}' })
  assert.equal(result.workerUrl, 'https://orca-relay.alice.workers.dev')
  const upload = api.calls.find((call) => call.metadata)
  assert.equal(upload.metadata.main_module, 'index.js')
  assert.deepEqual(upload.metadata.migrations, { new_tag: 'v1', new_sqlite_classes: ['RelayHost'] })
  assert.deepEqual(upload.metadata.bindings[0], { type: 'durable_object_namespace', name: 'RELAY', class_name: 'RelayHost' })
  assert.equal(upload.metadata.bindings[1].text, result.adminToken)
  assert.ok(api.calls.some((call) => call.method === 'POST' && call.path.endsWith('/orca-relay/subdomain') && call.body.enabled === true))
})

test('redeploys keep the existing Durable Object data (no second migration)', async () => {
  const api = fakeApi({ scripts: [{ id: 'orca-relay', migration_tag: 'v1' }] })
  await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x', knownOurs: true })
  assert.equal(api.calls.find((call) => call.metadata).metadata.migrations, undefined)
})

test('retries without the migration when Cloudflare says it already ran', async () => {
  const api = fakeApi({ rejectMigrationOnce: true })
  await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x' })
  const uploads = api.calls.filter((call) => call.metadata)
  assert.equal(uploads.length, 2)
  assert.equal(uploads[1].metadata.migrations, undefined)
})

test('registers a workers.dev subdomain for brand-new accounts', async () => {
  const api = fakeApi({ subdomain: null })
  const result = await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x' })
  assert.match(result.workerUrl, /^https:\/\/orca-relay\.orca-[0-9a-f]{8}\.workers\.dev$/)
})

test('token link pre-fills the Workers Scripts edit permission', () => {
  const url = new URL(TOKEN_TEMPLATE_URL)
  assert.equal(url.origin + url.pathname, 'https://dash.cloudflare.com/profile/api-tokens')
  assert.deepEqual(JSON.parse(url.searchParams.get('permissionGroupKeys'))[0], { key: 'workers_scripts', type: 'edit' })
  assert.equal(url.searchParams.get('accountId'), '*')
  assert.equal(url.searchParams.get('zoneId'), 'all')
})

test('validates worker names and URLs', () => {
  assert.equal(validWorkerName('Orca-Relay'), 'orca-relay')
  assert.throws(() => validWorkerName('-bad'))
  assert.equal(normalizeWorkerUrl('https://orca-relay.alice.workers.dev/health'), 'https://orca-relay.alice.workers.dev')
  assert.throws(() => normalizeWorkerUrl('http://orca-relay.alice.workers.dev'))
})

test('builds the stable phone endpoint and desktop socket URLs', () => {
  assert.equal(phoneEndpoint('https://orca-relay.alice.workers.dev', 'abcdefghijklmnop'), 'wss://orca-relay.alice.workers.dev/v1/c/abcdefghijklmnop')
  // The desktop key travels in the Authorization header, never in the URL.
  assert.equal(relaySocketUrl('https://r.alice.workers.dev', '/v1/hosts/abcdefghijklmnop/control'), 'wss://r.alice.workers.dev/v1/hosts/abcdefghijklmnop/control')
})

test('registration retries Cloudflare propagation 404s, then succeeds', async () => {
  const answers = [
    new Response('<html><h1>There is nothing here yet</h1></html>', { status: 404 }),
    new Response('error code: 1042', { status: 404 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  ]
  let calls = 0
  const { registerRelayHost } = await import('../src/worker-deploy.mjs')
  await registerRelayHost({
    workerUrl: 'https://r.alice.workers.dev',
    hostId: 'abcdefghijklmnop',
    hostKey: 'k'.repeat(43),
    fetchImpl: async () => answers[calls++],
    retryMs: 1
  })
  assert.equal(calls, 3)
})

test('registration reports the URL and Cloudflare answer when it never succeeds', async () => {
  const { registerRelayHost } = await import('../src/worker-deploy.mjs')
  await assert.rejects(
    registerRelayHost({
      workerUrl: 'https://r.alice.workers.dev',
      hostId: 'abcdefghijklmnop',
      hostKey: 'k'.repeat(43),
      fetchImpl: async () => new Response('<h1>There is nothing here yet</h1>', { status: 404 }),
      timeoutMs: 5,
      retryMs: 1
    }),
    /r\.alice\.workers\.dev\/v1\/hosts\/<host>\/register failed: HTTP 404: There is nothing here yet/
  )
})

test('relay readiness needs several consecutive healthy answers', async () => {
  const { waitForRelay } = await import('../src/worker-deploy.mjs')
  const healthy = () => new Response(JSON.stringify({ service: 'orca-cloudflare-relay' }))
  const answers = [healthy(), new Response('nope', { status: 404 }), healthy(), healthy(), healthy()]
  let calls = 0
  await waitForRelay('https://r.alice.workers.dev', { fetchImpl: async () => answers[calls++], intervalMs: 1, timeoutMs: 20_000 })
  assert.equal(calls, 5)
})

test('redeploys reuse the stored admin secret', async () => {
  const api = fakeApi({ scripts: [{ id: 'orca-relay', migration_tag: 'v1' }] })
  const result = await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x', adminToken: 'kept-secret', knownOurs: true })
  assert.equal(result.adminToken, 'kept-secret')
  assert.equal(api.calls.find((call) => call.metadata).metadata.bindings[1].text, 'kept-secret')
})

test('registration rides out a stale-version 401 during rollout', async () => {
  const { registerRelayHost } = await import('../src/worker-deploy.mjs')
  const answers = [
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  ]
  let calls = 0
  await registerRelayHost({ workerUrl: 'https://r.a.workers.dev', hostId: 'abcdefghijklmnop', hostKey: 'k'.repeat(43), adminToken: 'a', fetchImpl: async () => answers[calls++], retryMs: 1 })
  assert.equal(calls, 2)
  await assert.rejects(
    registerRelayHost({ workerUrl: 'https://r.a.workers.dev', hostId: 'abcdefghijklmnop', hostKey: 'k'.repeat(43), adminToken: 'a', fetchImpl: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }), retryMs: 1, rolloutMs: 0 }),
    /admin token mismatch/
  )
})

const v2Hello = {
  type: 'e2ee_hello',
  v: 2,
  clientPublicKeyB64: 'A'.repeat(43) + '=',
  clientNonceB64: 'B'.repeat(22),
  capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
  context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
}

test('bridge admits only E2EE v2 direct hellos (replay-safe handshake)', () => {
  assert.equal(isE2EEV2Hello(JSON.stringify(v2Hello)), true)
  assert.equal(isE2EEV2Hello(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: 'x' })), false, 'legacy v1')
  assert.equal(isE2EEV2Hello(JSON.stringify({ ...v2Hello, v: 1 })), false)
  assert.equal(isE2EEV2Hello(JSON.stringify({ ...v2Hello, context: { ...v2Hello.context, transport: 'relay' } })), false)
  assert.equal(isE2EEV2Hello('{"type":"auth"}'), false)
  assert.equal(isE2EEV2Hello('not json'), false)
  assert.equal(isE2EEV2Hello(new ArrayBuffer(8)), false, 'binary first frame')
  assert.equal(isE2EEV2Hello(JSON.stringify({ ...v2Hello, pad: 'x'.repeat(5000) })), false, 'oversized')
})

/* ---- existing Cloudflare accounts ---- */

function existingAccountApi({ accounts, scripts = [], healthService = null }) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (url.endsWith('/health')) {
      return healthService ? new Response(JSON.stringify({ service: healthService })) : new Response('Hello World!')
    }
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    const ok = (result) => new Response(JSON.stringify({ success: true, result }))
    if (path.startsWith('/accounts?')) return ok(accounts)
    if (path.endsWith('/workers/scripts')) return ok(scripts)
    if (path.endsWith('/workers/subdomain')) return ok({ subdomain: 'alice' })
    if (init.method === 'PUT' || init.method === 'POST') return ok({})
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${path}` }] }), { status: 400 })
  }
  return { calls, fetchImpl, request: createCloudflareClient('tok', fetchImpl) }
}

test('an existing user with several accounts is asked which one, never guessed', async () => {
  const { AccountChoiceRequired } = await import('../src/worker-deploy.mjs')
  const api = existingAccountApi({ accounts: [{ id: 'a1', name: 'Personal' }, { id: 'a2', name: 'Team' }] })
  await assert.rejects(
    deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x' }),
    (error) => error instanceof AccountChoiceRequired && error.accounts.map((a) => a.name).join() === 'Personal,Team'
  )
  assert.ok(!api.calls.some((call) => call.startsWith('PUT')), 'nothing deployed before choosing')
  const chosen = await deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x', accountId: 'a2' })
  assert.equal(chosen.accountId, 'a2')
})

test("an existing Worker with the same name is never overwritten", async () => {
  const { WorkerNameTaken } = await import('../src/worker-deploy.mjs')
  const api = existingAccountApi({ accounts: [{ id: 'a1', name: 'Personal' }], scripts: [{ id: 'orca-relay' }] })
  await assert.rejects(
    deployRelayWorker({ request: api.request, apiToken: 'tok', fetchImpl: api.fetchImpl, source: 'x' }),
    (error) => error instanceof WorkerNameTaken && /already has a Worker named "orca-relay"/.test(error.message)
  )
  assert.ok(!api.calls.some((call) => call.startsWith('PUT')), 'the existing Worker was not touched')
})

test('an existing relay of ours (by health, or our own earlier deploy) is updated in place', async () => {
  const byHealth = existingAccountApi({ accounts: [{ id: 'a1' }], scripts: [{ id: 'orca-relay' }], healthService: 'orca-cloudflare-relay' })
  await deployRelayWorker({ request: byHealth.request, apiToken: 'tok', fetchImpl: byHealth.fetchImpl, source: 'x' })
  assert.ok(byHealth.calls.some((call) => call.startsWith('PUT') && call.includes('/workers/scripts/orca-relay')))
  const known = existingAccountApi({ accounts: [{ id: 'a1' }], scripts: [{ id: 'orca-relay' }] })
  await deployRelayWorker({ request: known.request, apiToken: 'tok', fetchImpl: known.fetchImpl, source: 'x', knownOurs: true })
  assert.ok(known.calls.some((call) => call.startsWith('PUT') && call.includes('/workers/scripts/orca-relay')))
})
