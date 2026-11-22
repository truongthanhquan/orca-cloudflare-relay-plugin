import { randomBytes } from 'node:crypto'

const API = 'https://api.cloudflare.com/client/v4'

export function createCloudflareClient(apiToken, fetchImpl = fetch) {
  return async function request(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.success !== true) {
      const message =
        payload?.errors?.map((error) => error.message).filter(Boolean).join('; ') ||
        `Cloudflare API returned HTTP ${response.status}`
      throw new Error(`${message} (${method} ${path.split('?')[0]})`)
    }
    return payload.result
  }
}

/** Turns Cloudflare's authorization errors into "the token is missing <permission>". */
async function needs(promise, permission) {
  try {
    return await promise
  } catch (error) {
    if (/authentication|unauthori[sz]ed|forbidden|permission|not authorized|10000|9109/i.test(error.message)) {
      throw new Error(`Your token is missing the "${permission}" permission. Edit the token in Cloudflare (My Profile → API Tokens) to add it, then try again.`)
    }
    throw error
  }
}

/**
 * One-click token link for "Tunnel on your domain". Cloudflare silently drops keys it does not
 * know on user-token links, so the panel also asks the person to check the summary, and the
 * pre-flight checks name any permission that is still missing.
 */
export const TUNNEL_TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?' +
  new URLSearchParams({
    permissionGroupKeys: JSON.stringify([
      { key: 'cloudflare_tunnel', type: 'edit' },
      { key: 'dns', type: 'edit' },
      { key: 'zone', type: 'read' }
    ]),
    accountId: '*',
    zoneId: 'all',
    name: 'Orca tunnel setup'
  }).toString()

/**
 * A tunnel token copied from the Cloudflare dashboard (the value after `--token` in the
 * connector install command): base64 JSON { a: accountTag, t: tunnelId, s: secret }.
 */
export function parseTunnelToken(value) {
  // Accept the bare token or a whole pasted command (`cloudflared service install <token>`,
  // `cloudflared tunnel run --token <token>`, with or without sudo).
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean).reverse()
  for (const word of words) {
    try {
      const decoded = JSON.parse(Buffer.from(word, 'base64').toString('utf8'))
      if (typeof decoded?.a === 'string' && typeof decoded?.t === 'string' && typeof decoded?.s === 'string') {
        return { token: word, accountId: decoded.a, tunnelId: decoded.t }
      }
    } catch {
      // Not this word.
    }
  }
  throw new Error('That is not a Cloudflare Tunnel token. Copy the token from the tunnel\'s install command (the long value after --token), or paste the whole command.')
}

/** Lower-cased hostname without scheme, port or path. Throws on anything else. */
export function normalizeHostname(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  let url
  try {
    url = new URL(`https://${raw}`)
  } catch {
    url = null
  }
  if (!url || url.hostname !== raw || !raw.includes('.') || /^[\d.]+$/.test(raw)) {
    throw new Error('Enter a hostname such as orca.example.com (no https://, port or path).')
  }
  return raw
}

/** Most specific first: a.b.example.com → [a.b.example.com, b.example.com, example.com]. */
export function zoneCandidates(hostname) {
  const labels = hostname.split('.')
  const out = []
  for (let i = 0; i < labels.length - 1; i += 1) out.push(labels.slice(i).join('.'))
  return out
}

export async function findZone(request, hostname) {
  for (const name of zoneCandidates(hostname)) {
    const zones = await request('GET', `/zones?name=${encodeURIComponent(name)}&per_page=5`)
    const zone = Array.isArray(zones) ? zones.find((item) => item.name === name) : null
    if (zone) return zone
  }
  throw new Error(
    `No Cloudflare zone for ${hostname} is visible to this token. Add the domain to your Cloudflare account (the Free plan works) and give the token Zone:Read for it.`
  )
}

export function tunnelIngress(hostname, port) {
  return {
    config: {
      ingress: [
        { hostname, service: `http://127.0.0.1:${port}`, originRequest: {} },
        { service: 'http_status:404' }
      ]
    }
  }
}

async function findOrCreateTunnel(request, accountId, name) {
  const existing = await request(
    'GET',
    `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`
  )
  const match = Array.isArray(existing) ? existing.find((item) => item.name === name) : null
  if (match) return match
  return request('POST', `/accounts/${accountId}/cfd_tunnel`, {
    name,
    config_src: 'cloudflare',
    tunnel_secret: randomBytes(32).toString('base64')
  })
}

async function ensureDnsRecord(request, zoneId, hostname, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`
  const records = await request('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`)
  const record = {
    type: 'CNAME',
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
    comment: 'Orca Cloudflare Relay plugin'
  }
  const current = Array.isArray(records) ? records : []
  if (current.length === 0) {
    await request('POST', `/zones/${zoneId}/dns_records`, record)
    return
  }
  const ours = current.find((item) => item.type === 'CNAME' && /\.cfargotunnel\.com$/i.test(item.content))
  if (!ours || current.length > 1) {
    throw new Error(
      `${hostname} already has a DNS record that is not a Cloudflare Tunnel. Pick an unused hostname so nothing existing is overwritten.`
    )
  }
  if (ours.content !== target || ours.proxied !== true) {
    await request('PUT', `/zones/${zoneId}/dns_records/${ours.id}`, record)
  }
}

/**
 * Creates (or reuses) a remotely managed Cloudflare Tunnel that forwards `hostname` to the
 * desktop's local Orca WebSocket port, points DNS at it, and returns its run token.
 * Everything used is available on Cloudflare's Free plan.
 */
export async function provisionNamedTunnel({ request, hostname, tunnelName, port }) {
  const zone = await findZone(request, hostname)
  const accountId = zone.account?.id
  if (!accountId) throw new Error('Cloudflare did not report the account that owns this zone.')
  // Pre-flight with read-only calls, so a token missing a permission fails before anything is created.
  await needs(request('GET', `/accounts/${accountId}/cfd_tunnel?per_page=1`), 'Account · Cloudflare Tunnel · Edit')
  await needs(request('GET', `/zones/${zone.id}/dns_records?per_page=1`), 'Zone · DNS · Edit')
  const tunnel = await needs(findOrCreateTunnel(request, accountId, tunnelName), 'Account · Cloudflare Tunnel · Edit')
  await request('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, tunnelIngress(hostname, port))
  await needs(ensureDnsRecord(request, zone.id, hostname, tunnel.id), 'Zone · DNS · Edit')
  const token = await request('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`)
  if (typeof token !== 'string' || !token) throw new Error('Cloudflare returned no tunnel token.')
  return { accountId, zoneId: zone.id, zoneName: zone.name, tunnelId: tunnel.id, tunnelName, hostname, token }
}

/** Re-points an existing tunnel at a new local port (Orca can move to a fallback port). */
export async function updateTunnelPort({ request, accountId, tunnelId, hostname, port }) {
  await request('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, tunnelIngress(hostname, port))
}

/** Removes the DNS record (only if it still points at this tunnel) and deletes the tunnel. */
export async function deleteNamedTunnel({ request, accountId, zoneId, tunnelId, hostname }) {
  const records = await request('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`)
  for (const record of Array.isArray(records) ? records : []) {
    if (record.type === 'CNAME' && record.content === `${tunnelId}.cfargotunnel.com`) {
      await request('DELETE', `/zones/${zoneId}/dns_records/${record.id}`)
    }
  }
  await request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`).catch(() => {})
  await request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
}

/**
 * Whether a token still works, without changing anything. Tokens made from the plugin's link are
 * user tokens; account-owned tokens verify under their account.
 */
export async function verifyCloudflareToken(request, accountId) {
  let lastError = null
  let accountIds = accountId ? [accountId] : []
  if (!accountId) {
    // Account-owned tokens verify under their account; find it when we do not know it yet.
    const accounts = await request('GET', '/accounts?per_page=50').catch(() => [])
    accountIds = Array.isArray(accounts) ? accounts.map((account) => account.id) : []
  }
  for (const path of ['/user/tokens/verify', ...accountIds.map((id) => `/accounts/${id}/tokens/verify`)]) {
    try {
      const result = await request('GET', path)
      return { valid: result?.status === 'active', status: result?.status ?? 'unknown', expiresOn: result?.expires_on ?? null }
    } catch (error) {
      lastError = error
    }
  }
  return { valid: false, status: 'invalid', error: lastError?.message ?? 'Cloudflare rejected the token.' }
}
