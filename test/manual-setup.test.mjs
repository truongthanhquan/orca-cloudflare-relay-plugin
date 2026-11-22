import assert from 'node:assert/strict'
import test from 'node:test'
import { TUNNEL_TOKEN_TEMPLATE_URL, createCloudflareClient, parseTunnelToken, provisionNamedTunnel } from '../src/cloudflare-api.mjs'
import { CustomEndpoint, normalizeCustomEndpoint, probeUrl } from '../src/custom-endpoint.mjs'

const tunnelToken = Buffer.from(JSON.stringify({ a: 'acct123', t: 'tun-456', s: 'c2VjcmV0' })).toString('base64')

test('accepts a tunnel token, or the whole install command it came in', () => {
  assert.deepEqual(parseTunnelToken(tunnelToken), { token: tunnelToken, accountId: 'acct123', tunnelId: 'tun-456' })
  assert.equal(parseTunnelToken(`sudo cloudflared service install ${tunnelToken}`).tunnelId, 'tun-456', 'install command without --token')
  assert.equal(parseTunnelToken(`cloudflared tunnel run --token ${tunnelToken}`).tunnelId, 'tun-456')
  assert.throws(() => parseTunnelToken('cf-api-token-abc'), /not a Cloudflare Tunnel token/)
})

test('tunnel token link pre-fills tunnel, DNS and zone permissions', () => {
  const keys = JSON.parse(new URL(TUNNEL_TOKEN_TEMPLATE_URL).searchParams.get('permissionGroupKeys'))
  assert.deepEqual(keys.map((k) => `${k.key}:${k.type}`), ['cloudflare_tunnel:edit', 'dns:edit', 'zone:read'])
})

test('a token missing a permission fails before anything is created, naming it', async () => {
  const calls = []
  const request = createCloudflareClient('t', async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    calls.push(`${init.method} ${path}`)
    if (path.startsWith('/zones?name=example.com')) return new Response(JSON.stringify({ success: true, result: [{ id: 'z', name: 'example.com', account: { id: 'a' } }] }))
    if (path.startsWith('/zones?')) return new Response(JSON.stringify({ success: true, result: [] }))
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })
  })
  await assert.rejects(provisionNamedTunnel({ request, hostname: 'orca.example.com', tunnelName: 'x', port: 6768 }), /missing the "Account · Cloudflare Tunnel · Edit" permission/)
  assert.ok(!calls.some((call) => call.startsWith('POST') || call.startsWith('PUT')), 'nothing was created')
})

test('your own address must be a public TLS address', () => {
  assert.equal(normalizeCustomEndpoint('https://orca.example.com/'), 'wss://orca.example.com')
  assert.equal(normalizeCustomEndpoint('wss://orca.example.com/orca'), 'wss://orca.example.com/orca')
  assert.throws(() => normalizeCustomEndpoint('ws://orca.example.com'), /wss/)
  assert.throws(() => normalizeCustomEndpoint('orca.example.com'), /public address/)
  assert.equal(probeUrl('wss://orca.example.com/orca?x=1'), 'https://orca.example.com/web-index.html')
})

test('your own address reports honestly whether it reaches Orca', async () => {
  let answer = new Response('<html>', { status: 200 })
  const endpoint = new CustomEndpoint({ fetchImpl: async () => answer })
  endpoint.start({ endpoint: 'wss://orca.example.com', port: 6768 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(endpoint.status.state, 'connected')
  answer = new Response('bad gateway', { status: 502 })
  await endpoint.probe()
  assert.equal(endpoint.status.state, 'error')
  assert.match(endpoint.status.message, /forwards to http:\/\/127\.0\.0\.1:6768/)
  endpoint.stop()
})
