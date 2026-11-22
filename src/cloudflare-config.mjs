function httpsUrl(value, name, originOnly = false) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be a valid HTTPS URL`)
  }
  if (originOnly && (url.pathname !== '/' || url.search)) {
    throw new Error(`${name} must be a canonical HTTPS origin`)
  }
  return originOnly ? url.origin : url.toString()
}

function hostname(value, name) {
  try {
    const url = new URL(`https://${value}`)
    if (url.hostname !== value || url.username || url.password || url.port) {
      throw new Error('invalid hostname')
    }
    return url.hostname
  } catch {
    throw new Error(`${name} must be a hostname without scheme or port`)
  }
}

export function generateCloudflareConfig(input) {
  const accountId = String(input.accountId ?? '').trim()
  const workerName = String(input.workerName ?? 'orca-relay-edge').trim()
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workerName)) {
    throw new Error('Worker name must contain only letters, numbers, hyphens, and underscores')
  }
  const director = hostname(String(input.domain ?? input.relayDomain ?? '').trim(), 'Relay hostname')
  const jwksUrl = httpsUrl(
    String(input.jwksUrl ?? 'https://login.onorca.dev/.well-known/jwks.json').trim(),
    'JWKS URL'
  )
  const authIssuer = httpsUrl(
    String(input.authIssuer ?? 'https://login.onorca.dev').trim(),
    'JWT issuer',
    true
  )
  const adminIssuer = httpsUrl(
    String(input.adminIssuer ?? 'https://login.onorca.dev').trim(),
    'Director admin issuer',
    true
  )
  const audience = String(input.audience ?? 'orca-relay').trim()
  if (!audience) throw new Error('JWT audience is required')

  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(workerName)},
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": ${JSON.stringify(accountId)},
  "workers_dev": false,
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
    "RELAY_JWT_AUDIENCE": ${JSON.stringify(audience)},
    "ADMIN_ISSUER": ${JSON.stringify(adminIssuer)},
    "PING_INTERVAL_MS": "30000",
    "SILENCE_TIMEOUT_MS": "75000",
    "ORPHAN_GRACE_MS": "30000"
  },
  "routes": [
    { "pattern": ${JSON.stringify(director)}, "custom_domain": true }
  ]
}
`
}
