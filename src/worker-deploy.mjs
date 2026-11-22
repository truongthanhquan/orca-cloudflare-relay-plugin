import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const WORKER_SOURCE_PATH = fileURLToPath(new URL('../worker/src/index.js', import.meta.url))
export const WORKER_COMPATIBILITY_DATE = '2026-11-01'
export const WORKER_MIGRATION_TAG = 'v1'

/**
 * One-click "create token" link: opens Cloudflare's token form with the only permission the
 * deploy needs already filled in (Account · Workers Scripts · Edit).
 */
export const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?' +
  new URLSearchParams({
    permissionGroupKeys: JSON.stringify([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'account_settings', type: 'read' }
    ]),
    accountId: '*',
    zoneId: 'all',
    name: 'Orca Relay deploy'
  }).toString()

export const DEPLOY_BUTTON_URL =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/truongthanhquan/orca-cloudflare-relay-plugin/tree/main/worker'

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function validWorkerName(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error('Worker name must be lowercase letters, numbers and hyphens (max 63).')
  }
  return name
}

/** https origin of a relay Worker, from a URL the user pasted. */
export function normalizeWorkerUrl(value) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw new Error('Enter the Worker URL, for example https://orca-relay.you.workers.dev')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('The Worker URL must start with https://')
  }
  return url.origin
}

/** Raw multipart request — the JSON client cannot send a script upload. */
async function uploadScript({ apiToken, accountId, scriptName, metadata, source, fetchImpl }) {
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('index.js', new Blob([source], { type: 'application/javascript+module' }), 'index.js')
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${apiToken}` }, body: form }
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const message = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ')
    throw new Error(`Uploading the relay Worker failed: ${message || `HTTP ${response.status}`}`)
  }
  return payload.result
}

/** The token reaches several accounts and the person has not said which one to deploy to. */
export class AccountChoiceRequired extends Error {
  constructor(accounts) {
    super('Your token can reach more than one Cloudflare account. Choose the account for the relay.')
    this.accounts = accounts.map((account) => ({ id: account.id, name: account.name ?? account.id }))
  }
}

/** A Worker with the chosen name already exists in the account and is not this relay. */
export class WorkerNameTaken extends Error {}

export async function listAccounts(request) {
  const accounts = await request('GET', '/accounts?per_page=50')
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('This token cannot see any Cloudflare account. Create it with the "Create token" button.')
  }
  return accounts
}

async function pickAccount(request, accountId) {
  const accounts = await listAccounts(request)
  if (accountId) {
    const match = accounts.find((account) => account.id === accountId)
    if (!match) throw new Error(`The token has no access to account ${accountId}. Choose another account or create the token for it.`)
    return match
  }
  // Never guess between someone's personal and team accounts.
  if (accounts.length > 1) throw new AccountChoiceRequired(accounts)
  return accounts[0]
}

/**
 * Whether an existing Worker of that name is this relay: known from our own earlier deploy, or
 * its workers.dev health endpoint identifies itself. Anything else belongs to the person.
 */
async function isOurRelay({ request, accountId, scriptName, knownOurs, fetchImpl }) {
  if (knownOurs) return true
  const current = await request('GET', `/accounts/${accountId}/workers/subdomain`).catch(() => null)
  if (!current?.subdomain) return false
  try {
    const response = await fetchImpl(`https://${scriptName}.${current.subdomain}.workers.dev/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000)
    })
    const payload = await response.json().catch(() => null)
    return payload?.service === 'orca-cloudflare-relay'
  } catch {
    return false
  }
}

/** The account's `<name>.workers.dev` subdomain, registering one for brand-new accounts. */
export async function ensureWorkersSubdomain(request, accountId) {
  const current = await request('GET', `/accounts/${accountId}/workers/subdomain`).catch(() => null)
  if (current?.subdomain) return current.subdomain
  const wanted = `orca-${randomBytes(4).toString('hex')}`
  const created = await request('PUT', `/accounts/${accountId}/workers/subdomain`, { subdomain: wanted })
  return created?.subdomain ?? wanted
}

/**
 * Deploys (or updates) the relay Worker in the user's account using only the Cloudflare API —
 * no wrangler, Node toolchain or build step. Everything used is on the Workers Free plan.
 */
export async function deployRelayWorker({ request, apiToken, accountId, scriptName = 'orca-relay', fetchImpl = fetch, source, adminToken: existingAdminToken, knownOurs = false }) {
  const name = validWorkerName(scriptName)
  const account = await pickAccount(request, accountId)
  const scripts = await request('GET', `/accounts/${account.id}/workers/scripts`).catch(() => [])
  const existing = Array.isArray(scripts) ? scripts.find((script) => script.id === name) : null
  // An existing account may already have a Worker with this name: never overwrite someone's project.
  if (existing && !(await isOurRelay({ request, accountId: account.id, scriptName: name, knownOurs, fetchImpl }))) {
    throw new WorkerNameTaken(
      `Your account "${account.name ?? account.id}" already has a Worker named "${name}" that is not this relay. Set "Advanced: Relay Worker name" to another name (for example orca-relay-2) and deploy again.`
    )
  }
  // Reuse this desktop's admin secret: a new one per deploy races Cloudflare's gradual rollout
  // (edges still running the previous version would reject registration).
  const adminToken = existingAdminToken || randomSecret()
  const metadata = {
    main_module: 'index.js',
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    bindings: [
      { type: 'durable_object_namespace', name: 'RELAY', class_name: 'RelayHost' },
      { type: 'secret_text', name: 'RELAY_ADMIN_TOKEN', text: adminToken }
    ],
    observability: { enabled: false }
  }
  // The SQLite Durable Object class is created once; re-deploys keep its data.
  if (!existing?.migration_tag) {
    metadata.migrations = { new_tag: WORKER_MIGRATION_TAG, new_sqlite_classes: ['RelayHost'] }
  }
  const upload = {
    apiToken,
    accountId: account.id,
    scriptName: name,
    metadata,
    source: source ?? (await readFile(WORKER_SOURCE_PATH, 'utf8')),
    fetchImpl
  }
  try {
    await uploadScript(upload)
  } catch (error) {
    // An existing script that already ran the migration rejects it a second time.
    if (!metadata.migrations || !/migration/i.test(error.message)) throw error
    delete metadata.migrations
    await uploadScript(upload)
  }
  await request('POST', `/accounts/${account.id}/workers/scripts/${name}/subdomain`, {
    enabled: true,
    previews_enabled: false
  })
  const subdomain = await ensureWorkersSubdomain(request, account.id)
  return {
    accountId: account.id,
    accountName: account.name,
    scriptName: name,
    workerUrl: `https://${name}.${subdomain}.workers.dev`,
    adminToken
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function describe(response) {
  const text = await response.text().catch(() => '')
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // Not JSON: Cloudflare's own error page, typically while a route propagates.
  }
  const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return { payload, snippet }
}

/**
 * Binds the desktop's host id to its secret key on the relay. A freshly enabled workers.dev
 * route propagates across Cloudflare's edge gradually, so non-relay answers (404/5xx from
 * Cloudflare itself) are retried for a while before giving up.
 */
export async function registerRelayHost({ workerUrl, hostId, hostKey, adminToken, fetchImpl = fetch, timeoutMs = 120_000, retryMs = 3000, rolloutMs = 45_000 }) {
  const headers = { 'content-type': 'application/json' }
  if (adminToken) headers.authorization = `Bearer ${adminToken}`
  const url = `${workerUrl}/v1/hosts/${hostId}/register`
  const deadline = Date.now() + timeoutMs
  const rolloutDeadline = Date.now() + Math.min(rolloutMs, timeoutMs)
  let last = 'no answer'
  for (;;) {
    let response = null
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ key: hostKey }) })
    } catch (error) {
      last = error?.cause?.code ?? error?.message ?? String(error)
    }
    if (response) {
      const { payload, snippet } = await describe(response)
      if (response.ok && payload?.ok) return
      if (response.status === 401 && payload?.error === 'unauthorized') {
        // Right after a deploy, some edges may still run the previous version and secret.
        if (Date.now() > rolloutDeadline) {
          throw new Error('The relay refused registration (admin token mismatch). Deploy again from this desktop.')
        }
      }
      if (response.status === 409 && payload?.error === 'host_id_taken') {
        throw new Error('This host id is already registered with a different key.')
      }
      if (response.status === 400 && payload?.error) throw new Error(`Relay registration failed: ${payload.error}`)
      last = `HTTP ${response.status}${payload?.error ? ` ${payload.error}` : snippet ? `: ${snippet}` : ''}`
    }
    if (Date.now() + retryMs > deadline) break
    await sleep(retryMs)
  }
  throw new Error(`Relay registration at ${url.replace(hostId, '<host>')} failed: ${last}. The Worker may still be propagating; click Deploy and connect again in a minute.`)
}

/**
 * New workers.dev hostnames take a while before every Cloudflare edge serves them. Polls the
 * relay's health endpoint until it identifies itself several times in a row.
 */
export async function waitForRelay(workerUrl, { timeoutMs = 120_000, fetchImpl = fetch, onWait = () => {}, required = 3, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  let streak = 0
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${workerUrl}/health?t=${Date.now()}`, { cache: 'no-store' })
      const { payload, snippet } = await describe(response)
      if (payload?.service === 'orca-cloudflare-relay') {
        streak += 1
        if (streak >= required) return payload
      } else {
        streak = 0
        lastError = new Error(`HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`)
      }
    } catch (error) {
      streak = 0
      lastError = error
    }
    onWait()
    await sleep(streak > 0 ? 1000 : intervalMs)
  }
  throw new Error(`The relay at ${workerUrl} is not answering yet (${lastError?.cause?.code ?? lastError?.message}). Try again in a minute.`)
}
