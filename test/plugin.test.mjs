import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createCloudflareClient,
  normalizeHostname,
  provisionNamedTunnel,
  zoneCandidates
} from '../src/cloudflare-api.mjs'
import { cloudflaredAsset } from '../src/cloudflared-binary.mjs'
import { findOrcaWebSocketPort, orcaCliCandidates, parseCliJson, portFromRuntimeMetadata } from '../src/orca-runtime.mjs'
import { qrSvg } from '../src/qr.mjs'
import { buildCloudflaredArgs, isConnectedLine, parseQuickTunnelHost } from '../src/tunnel-process.mjs'

test('reads the desktop WebSocket port from runtime metadata', () => {
  assert.equal(
    portFromRuntimeMetadata({ transports: [{ kind: 'unix', endpoint: '/x.sock' }, { kind: 'websocket', endpoint: 'ws://0.0.0.0:6768' }] }),
    6768
  )
  assert.equal(portFromRuntimeMetadata({ transport: { kind: 'websocket', endpoint: 'ws://127.0.0.1:6771' } }), 6771)
  assert.equal(portFromRuntimeMetadata({ transports: [] }), null)
})

test('port discovery falls back from setting to runtime file to fallback file to default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cf-'))
  assert.deepEqual(await findOrcaWebSocketPort({ userDataDir: dir }), { port: 6768, source: 'default' })
  await writeFile(join(dir, 'mobile-ws-fallback-port.json'), JSON.stringify({ port: 6772 }))
  assert.deepEqual(await findOrcaWebSocketPort({ userDataDir: dir }), { port: 6772, source: 'fallback' })
  await writeFile(join(dir, 'orca-runtime.json'), JSON.stringify({ transports: [{ kind: 'websocket', endpoint: 'ws://0.0.0.0:6770' }] }))
  assert.deepEqual(await findOrcaWebSocketPort({ userDataDir: dir }), { port: 6770, source: 'runtime' })
  assert.deepEqual(await findOrcaWebSocketPort({ userDataDir: dir, override: 7000 }), { port: 7000, source: 'setting' })
})

test('finds the CLI bundled next to the Orca executable first', () => {
  const [first] = orcaCliCandidates({ platform: 'darwin', execPath: '/Applications/Orca.app/Contents/MacOS/Orca', pathEnv: '', home: '/Users/me' })
  assert.equal(first, '/Applications/Orca.app/Contents/Resources/bin/orca')
  const [linux] = orcaCliCandidates({ platform: 'linux', execPath: '/opt/Orca/orca', pathEnv: '', home: '/home/me' })
  assert.equal(linux, '/opt/Orca/resources/bin/orca-ide')
})

test('parses orca --json results and errors', () => {
  assert.deepEqual(parseCliJson('{"id":"x","ok":true,"result":{"available":true,"endpoint":"wss://a.b"}}'), {
    available: true,
    endpoint: 'wss://a.b'
  })
  assert.throws(() => parseCliJson('{"ok":false,"error":{"code":"x","message":"nope"}}'), /nope/)
})

test('parses quick tunnel announcements and connection lines', () => {
  const line = '2026-11-22T10:00:00Z INF |  https://brave-otter-river.trycloudflare.com                                      |'
  assert.equal(parseQuickTunnelHost(line), 'brave-otter-river.trycloudflare.com')
  assert.equal(parseQuickTunnelHost('ERR failed to request quick Tunnel: https://api.trycloudflare.com/tunnel'), null)
  assert.ok(isConnectedLine('INF Registered tunnel connection connIndex=0 location=sin01 protocol=quic'))
})

test('builds cloudflared arguments that never put the token on the command line', () => {
  assert.deepEqual(buildCloudflaredArgs({ mode: 'quick', port: 6768, configPath: '/c.yml' }), [
    'tunnel', '--no-autoupdate', '--config', '/c.yml', '--url', 'http://127.0.0.1:6768'
  ])
  assert.deepEqual(buildCloudflaredArgs({ mode: 'named', port: 6768, configPath: '/c.yml', token: 'secret' }), [
    'tunnel', '--no-autoupdate', '--config', '/c.yml', 'run'
  ])
})

test('picks a pinned, checksummed cloudflared asset per platform', () => {
  const asset = cloudflaredAsset('darwin', 'arm64')
  assert.match(asset.url, /releases\/download\/\d{4}\.\d+\.\d+\/cloudflared-darwin-arm64\.tgz$/)
  assert.match(asset.sha256, /^[0-9a-f]{64}$/)
  assert.equal(cloudflaredAsset('win32', 'x64').binaryName, 'cloudflared.exe')
  assert.throws(() => cloudflaredAsset('aix', 'ppc64'))
})

test('validates hostnames and zone candidates', () => {
  assert.equal(normalizeHostname(' Orca.Example.com. '), 'orca.example.com')
  assert.throws(() => normalizeHostname('https://orca.example.com'))
  assert.throws(() => normalizeHostname('orca.example.com:443'))
  assert.throws(() => normalizeHostname('localhost'))
  assert.deepEqual(zoneCandidates('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com'])
})

function fakeCloudflare({ dns = [] } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '')
    const method = init.method
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined })
    let result
    if (method === 'GET' && path.startsWith('/zones?name=example.com')) result = [{ id: 'zone1', name: 'example.com', account: { id: 'acct1' } }]
    else if (method === 'GET' && path.startsWith('/zones?')) result = []
    else if (method === 'GET' && path.startsWith('/accounts/acct1/cfd_tunnel?')) result = []
    else if (method === 'POST' && path === '/accounts/acct1/cfd_tunnel') result = { id: 'tun1', name: 'orca-desktop' }
    else if (method === 'PUT' && path.endsWith('/configurations')) result = {}
    else if (method === 'GET' && path.startsWith('/zones/zone1/dns_records?')) result = dns
    else if (method === 'POST' && path === '/zones/zone1/dns_records') result = { id: 'rec1' }
    else if (method === 'GET' && path.endsWith('/token')) result = 'tunnel-token'
    else return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 400 })
    return new Response(JSON.stringify({ success: true, result }), { status: 200 })
  }
  return { calls, request: createCloudflareClient('api-token', fetchImpl) }
}

test('provisions a free-plan named tunnel pointing at the local Orca port', async () => {
  const { calls, request } = fakeCloudflare()
  const result = await provisionNamedTunnel({ request, hostname: 'orca.example.com', tunnelName: 'orca-desktop', port: 6768 })
  assert.equal(result.token, 'tunnel-token')
  assert.equal(result.tunnelId, 'tun1')
  const config = calls.find((call) => call.path.endsWith('/configurations'))
  assert.deepEqual(config.body.config.ingress[0], { hostname: 'orca.example.com', service: 'http://127.0.0.1:6768', originRequest: {} })
  const dns = calls.find((call) => call.method === 'POST' && call.path.endsWith('/dns_records'))
  assert.equal(dns.body.content, 'tun1.cfargotunnel.com')
  assert.equal(dns.body.proxied, true)
})

test('refuses to overwrite an unrelated DNS record', async () => {
  const { request } = fakeCloudflare({ dns: [{ id: 'r', type: 'A', name: 'orca.example.com', content: '1.2.3.4' }] })
  await assert.rejects(
    provisionNamedTunnel({ request, hostname: 'orca.example.com', tunnelName: 'orca-desktop', port: 6768 }),
    /already has a DNS record/
  )
})

test('renders a QR code as SVG', () => {
  const svg = qrSvg('orca://pair?code=abc')
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/)
  assert.match(svg, /<path d="M/)
})
