import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!key?.startsWith('--')) throw new Error(`Invalid argument: ${key ?? ''}`)
  args.set(key.slice(2), process.argv[i + 1])
}

const apiToken = String(args.get('apiToken') ?? process.env.CLOUDFLARE_API_TOKEN ?? '').trim()
const relayDomain = String(args.get('relayDomain') ?? '').trim()
if (!apiToken) throw new Error('Cloudflare API token is required')
if (!relayDomain) throw new Error('Relay hostname is required')

async function cf(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const message = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ')
    throw new Error(message || `Cloudflare API returned HTTP ${response.status}`)
  }
  return payload.result
}

function host(value) {
  const url = new URL(`https://${value}`)
  if (url.hostname !== value || url.username || url.password || url.port) {
    throw new Error('Relay hostname must not include a scheme or port')
  }
  return url.hostname
}

const hostname = host(relayDomain)
const accounts = await cf('GET', '/accounts?per_page=50')
if (!Array.isArray(accounts) || accounts.length === 0) {
  throw new Error('No Cloudflare account is accessible by this API token')
}
const accountId = String(args.get('accountId') ?? accounts[0].id)
const account = accounts.find((item) => item.id === accountId) ?? accounts[0]

const zones = await cf(
  'GET',
  `/zones?account.id=${encodeURIComponent(account.id)}&name=${encodeURIComponent(hostname)}&per_page=50`
)
const zone = Array.isArray(zones)
  ? zones.find((item) => item.name === hostname || hostname.endsWith(`.${item.name}`))
  : null
if (!zone) {
  throw new Error(`Cloudflare zone not found for ${hostname}. Add the domain to account ${account.name ?? account.id} first.`)
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relayRoot = resolve(pluginRoot, 'worker/cloud/apps/relay-edge')
const deployConfig = resolve(relayRoot, '.wrangler-deploy-cloudflare.jsonc')
const adminSigningKey = randomBytes(48).toString('base64url')
const jwksUrl = String(args.get('jwksUrl') ?? 'https://login.onorca.dev/.well-known/jwks.json')
const authIssuer = String(args.get('authIssuer') ?? 'https://login.onorca.dev')
const workerName = String(args.get('workerName') ?? 'orca-relay-edge')

await writeFile(
  deployConfig,
  `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(workerName)},
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": ${JSON.stringify(account.id)},
  "workers_dev": false,
  "alias": {
    "@orca-cloud/relay-contract": "../../packages/relay-contract/src/index.ts",
    "@orca-cloud/relay-contract/persistence-invariants": "../../packages/relay-contract/src/persistence-invariants.ts",
    "@orca-cloud/relay-contract/protocol-limits": "../../packages/relay-contract/src/protocol-limits.ts"
  },
  "durable_objects": {
    "bindings": [
      { "name": "HOST_RELAY", "class_name": "HostRelay" },
      { "name": "SPLICE_RELAY", "class_name": "SpliceRelay" },
      { "name": "USER_HOSTS", "class_name": "UserHosts" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["HostRelay"] },
    { "tag": "v2", "new_sqlite_classes": ["SpliceRelay"] },
    { "tag": "v3", "new_sqlite_classes": ["UserHosts"] }
  ],
  "vars": {
    "EDGE_BACKEND": "object",
    "EDGE_CELL_ID": "edge",
    "RELAY_JWKS_URL": ${JSON.stringify(jwksUrl)},
    "RELAY_AUTH_ISSUER": ${JSON.stringify(authIssuer)},
    "RELAY_JWT_AUDIENCE": "orca-relay",
    "ADMIN_ISSUER": ${JSON.stringify(authIssuer)},
    "PING_INTERVAL_MS": "30000",
    "SILENCE_TIMEOUT_MS": "75000",
    "ORPHAN_GRACE_MS": "30000"
  },
  "routes": [
    { "pattern": ${JSON.stringify(hostname)}, "custom_domain": true }
  ]
}
`,
  { encoding: 'utf8', mode: 0o600 }
)

const install = spawnSync('npm', ['install', '--omit=dev'], {
  cwd: relayRoot,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken },
  encoding: 'utf8',
  timeout: 300_000
})
if (install.status !== 0) {
  throw new Error(`Could not install Wrangler runtime dependencies: ${install.stderr || install.stdout}`)
}

const deploy = spawnSync(
  'npx',
  ['--yes', 'wrangler@4.157.0', 'deploy', '--config', deployConfig, '--var', 'EDGE_VERSION:1.1.0'],
  {
    cwd: relayRoot,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken },
    encoding: 'utf8',
    timeout: 600_000
  }
)
if (deploy.status !== 0) {
  throw new Error(`Cloudflare deployment failed: ${deploy.stderr || deploy.stdout}`)
}

await cf(
  'PUT',
  `/accounts/${account.id}/workers/scripts/${encodeURIComponent(workerName)}/secrets/ADMIN_SIGNING_KEY`,
  { name: 'ADMIN_SIGNING_KEY', text: adminSigningKey, type: 'secret_text' }
)

await rm(deployConfig, { force: true })
console.log(JSON.stringify({
  ok: true,
  accountId: account.id,
  zoneId: zone.id,
  workerName,
  relayUrl: `https://${hostname}`,
  deployed: true
}))
