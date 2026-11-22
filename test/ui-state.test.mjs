import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCloudflareToken, createCloudflareClient } from '../src/cloudflare-api.mjs'
import { pickOwnPluginKey } from '../src/orca-runtime.mjs'
import { WorkerRelayBridge } from '../src/worker-relay-bridge.mjs'

test('finds this plugin key: running entry, preferring our version', () => {
  const list = {
    plugins: [
      { pluginKey: 'truongthanhquan.cloudflare-relay', status: 'disabled', version: '1.2.0' },
      { pluginKey: 'local.cloudflare-relay', status: 'running', version: '2.2.0' },
      { pluginKey: 'someone.other-plugin', status: 'running', version: '2.2.0' }
    ]
  }
  assert.equal(pickOwnPluginKey(list, { version: '2.2.0' }), 'local.cloudflare-relay')
  assert.equal(pickOwnPluginKey({ plugins: [list.plugins[0]] }), 'truongthanhquan.cloudflare-relay')
  assert.equal(pickOwnPluginKey({ plugins: [] }), null)
})

test('needsSetup marks only the error it came with', () => {
  const bridge = new WorkerRelayBridge()
  bridge.setStatus({ state: 'error', message: 'out of date', needsSetup: true })
  assert.equal(bridge.status.needsSetup, true)
  bridge.setStatus({ phones: 0 })
  assert.equal(bridge.status.needsSetup, true, 'unrelated patch keeps it')
  bridge.setStatus({ state: 'starting' })
  assert.equal(bridge.status.needsSetup, false)
  bridge.setStatus({ state: 'error', message: 'network' })
  assert.equal(bridge.status.needsSetup, false, 'a runtime error does not ask for setup')
})

test('verifies a token without changing anything', async () => {
  const ok = createCloudflareClient('t', async (url) => {
    assert.match(url, /\/user\/tokens\/verify$/)
    return new Response(JSON.stringify({ success: true, result: { status: 'active', expires_on: '2027-01-01T00:00:00Z' } }))
  })
  assert.deepEqual(await verifyCloudflareToken(ok), { valid: true, status: 'active', expiresOn: '2027-01-01T00:00:00Z' })
  const calls = []
  const bad = createCloudflareClient('t', async (url) => {
    calls.push(url)
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }), { status: 401 })
  })
  const result = await verifyCloudflareToken(bad, 'acct')
  assert.equal(result.valid, false)
  assert.equal(calls.length, 2, 'falls back to the account-token endpoint')
})
