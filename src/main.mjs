import {
  TUNNEL_TOKEN_TEMPLATE_URL,
  createCloudflareClient,
  deleteNamedTunnel,
  normalizeHostname,
  parseTunnelToken,
  provisionNamedTunnel,
  updateTunnelPort,
  verifyCloudflareToken
} from './cloudflare-api.mjs'
import { CustomEndpoint, normalizeCustomEndpoint } from './custom-endpoint.mjs'
import { ensureCloudflared } from './cloudflared-binary.mjs'
import { readFileSync } from 'node:fs'
import {
  countPairedPhones,
  pairedPhoneList,
  createMobilePairingOffer,
  findOrcaCli,
  findOrcaWebSocketPort,
  findOwnPluginKey,
  openPluginPanel,
  pairingDeviceToken,
  pairingRowFor,
  readDeviceRegistry,
  runPluginUpdate
} from './orca-runtime.mjs'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_POLICIES,
  bundledRelayInfo,
  compareVersions,
  belowMinimum,
  evaluateRelayUpdate,
  fetchReleaseInfo,
  higherMinimum,
  shouldAutoInstall,
  updateManifestUrl
} from './updates.mjs'
import { pluginCacheDir } from './paths.mjs'
import { rememberHostId, rememberedHostId } from './relay-identity.mjs'
import { qrSvg } from './qr.mjs'
import { TunnelProcess } from './tunnel-process.mjs'
import {
  DEPLOY_BUTTON_URL,
  AccountChoiceRequired,
  TOKEN_TEMPLATE_URL,
  WorkerNameTaken,
  deployRelayWorker,
  validWorkerName,
  normalizeWorkerUrl,
  randomSecret,
  registerRelayHost,
  waitForRelay
} from './worker-deploy.mjs'
import { MIN_RELAY_PROTOCOL, WorkerRelayBridge } from './worker-relay-bridge.mjs'

const STATUS_ITEM = 'tunnel'
const PANEL_ID = 'cloudflare-relay' // contributes.panels[0].id
const MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
})()
const PLUGIN_VERSION = MANIFEST.version
/** A shown pairing code is invalidated after this long (or when the relay stops). */
/** A JSON-safe copy: `undefined` object fields are removed (Orca's storage rejects them). */
export function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : withoutUndefined(item)))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([k, item]) => [k, withoutUndefined(item)]))
  }
  return value
}

export const PAIRING_CODE_TTL_MS = 5 * 60_000
/** How often a shown code checks whether a phone has used it. */
const PAIRING_WATCH_INTERVAL_MS = 1500
const MODES = ['worker', 'named', 'quick', 'custom']
const KEYS = {
  enabled: 'tunnel-enabled',
  setupComplete: 'setup-complete',
  welcomed: 'welcomed',
  named: 'named-tunnel',
  custom: 'custom-endpoint',
  worker: 'worker-relay',
  apiToken: 'cloudflareApiToken',
  tunnelToken: 'cloudflareTunnelToken',
  hostKey: 'relayHostKey',
  adminToken: 'relayAdminToken',
  /** Highest published minimums seen: { plugin, relay }. Kept so going offline can't skip one. */
  required: 'required-versions'
}

/** An error the user fixes in the panel's setup section (the panel opens it for them). */
class SetupRequired extends Error {}

/** A required (security) update is missing: the relay stays off until it is installed. */
class UpdateRequired extends Error {}

let tunnel = null
let bridge = null
let custom = null
let updateTimers = []

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Plugin updates are Orca's job (Settings → Plugins, and automatic catalog updates), so this
 * worker never updates itself on its own: it tells the person a newer version exists, and runs
 * Orca's own updater only when they click Update now. It does redeploy the relay Worker in the user's own Cloudflare account when the
 * bundled Worker is newer than the deployed one.
 * @param {import('orca/worker').OrcaWorkerApi} orca
 */
export default function activate(orca) {
  const cacheDir = pluginCacheDir()
  const log = (message) => orca.log(message)
  tunnel = new TunnelProcess({ cacheDir, log })
  bridge = new WorkerRelayBridge({ log })
  custom = new CustomEndpoint()
  tunnel.killOrphan()
  /** The transport whose status the UI shows. */
  let active = bridge
  let busy = null
  /** Endpoint of the pairing code currently on screen, and its expiry timer. */
  let shownCode = null

  /** Orca's storage accepts only strict JSON, so drop `undefined` fields before saving. */
  async function saveState(key, value) {
    await orca.storage.set(key, withoutUndefined(value))
  }

  async function settings() {
    const all = (await orca.settings.get()) ?? {}
    currentMode = MODES.includes(all.mode) ? all.mode : 'worker'
    return {
      mode: currentMode,
      hostname: typeof all.hostname === 'string' ? all.hostname.trim() : '',
      tunnelName: (typeof all.tunnelName === 'string' && all.tunnelName.trim()) || 'orca-desktop',
      workerName: (typeof all.workerName === 'string' && all.workerName.trim()) || 'orca-relay',
      autoStart: all.autoStart !== false,
      keepApiToken: all.keepApiToken === true,
      relayFallback: all.relayFallback === true,
      localPort: Number(all.localPort) || 0,
      cloudflaredPath: typeof all.cloudflaredPath === 'string' ? all.cloudflaredPath.trim() : '',
      orcaCliPath: typeof all.orcaCliPath === 'string' ? all.orcaCliPath.trim() : '',
      relayUpdates: UPDATE_POLICIES.includes(all.relayUpdates) ? all.relayUpdates : 'mandatory'
    }
  }

  function currentStatus() {
    const status = active.status
    return { ...status, endpoint: status.endpoint ?? (status.host ? `wss://${status.host}` : null) }
  }

  /** Whether setup has been completed for the chosen connection type (drives onboarding). */
  let isConfigured = false
  async function computeConfigured(config) {
    const c = config ?? (await settings())
    if (c.mode === 'worker') return Boolean((await orca.storage.get(KEYS.worker))?.workerUrl)
    if (c.mode === 'named') return Boolean((await orca.storage.get(KEYS.named))?.tunnelId)
    if (c.mode === 'custom') return Boolean((await orca.storage.get(KEYS.custom))?.endpoint)
    // Quick tunnels have nothing to provision: done once set up (or used before this version).
    return (await orca.storage.get(KEYS.setupComplete)) === true || (await orca.storage.get(KEYS.enabled)) === true
  }
  async function refreshConfigured(config) {
    const next = await computeConfigured(config)
    if (next !== isConfigured) {
      isConfigured = next
      renderStatusBar(currentStatus())
    }
    return isConfigured
  }

  /** This plugin's key in Orca (`local.…` for a development folder), found through the CLI. */
  let ownKey = null
  /** Latest check: { checkedAt, error, plugin: notice only, relay: {...} }. */
  const updates = { checkedAt: null, error: null, plugin: null, relay: null }
  /** Highest published minimums seen so far (kept in storage, so offline can't skip one). */
  let required = { plugin: null, relay: null }
  /** Last known version of the deployed relay Worker: { version, protocol }. */
  let relayState = null
  /** The connection type in use (a relay Worker minimum only applies to the Worker relay). */
  let currentMode = null
  let blockedNow = false

  function renderStatusBar(status) {
    const label = status.mode === 'worker' ? 'Cloudflare relay' : status.mode === 'custom' ? 'Your own address' : 'Cloudflare tunnel'
    const view = {
      stopped: { text: 'Relay off', tone: 'neutral', icon: 'cloud', tooltip: `${label} is off. Click to start.` },
      starting: { text: 'Relay…', tone: 'accent', icon: 'cloud', tooltip: status.message ?? 'Connecting…' },
      connected: {
        text: status.phones ? `Relay · ${status.phones} ${status.phones === 1 ? 'phone' : 'phones'}` : 'Relay on',
        tone: 'success',
        icon: 'cloud',
        tooltip: `Cloudflare relay is on: Orca Mobile can reach this desktop through ${status.endpoint}. Click to stop.`
      },
      error: { text: 'Relay error', tone: 'danger', icon: 'warning', tooltip: `${status.message ?? `${label} failed.`} Click to open Cloudflare Relay.` }
    }[status.state]
    if (status.state !== 'error') view.tooltip = `${view.tooltip.replace(/ Click to (start|stop)\.$/, '')} Click to open Cloudflare Relay.`
    if (!isConfigured && status.state === 'stopped') {
      Object.assign(view, {
        text: 'Set up relay',
        tone: 'accent',
        icon: 'cloud',
        tooltip: 'Cloudflare Relay is not set up yet. Click to connect Orca Mobile through your free Cloudflare account (about 2 minutes).'
      })
    }
    const blocked = blockReason()
    if (blocked) {
      Object.assign(view, { text: 'Update required', tone: 'danger', icon: 'warning', tooltip: `${blocked} Click to open Cloudflare Relay.` })
    } else if (updates.relay?.mandatory && status.state !== 'error') {
      view.text = 'Update relay'
      view.tone = 'warning'
      view.icon = 'warning'
      view.tooltip = `The relay Worker must be redeployed. ${view.tooltip}`
    } else if (updates.relay?.available || updates.plugin?.available) {
      view.text = `${view.text} · update`
      view.tooltip = updates.relay?.available
        ? `A relay Worker update is available. ${view.tooltip}`
        : `Update available: Cloudflare Relay ${updates.plugin.latest}. Click to update. ${view.tooltip.replace(/ Click to open Cloudflare Relay\.$/, '')}`
    }
    orca.host.call('statusBar.update', { id: STATUS_ITEM, ...view }).catch(() => {})
  }

  for (const transport of [tunnel, bridge, custom]) {
    transport.on('status', () => {
      if (transport !== active) return
      const status = currentStatus()
      renderStatusBar(status)
      orca.panels.post('status', status)
    })
  }
  renderStatusBar(currentStatus())

  function use(transport) {
    if (active !== transport) active.stop({ silent: true })
    active = transport
  }

  async function cloudflareRequest() {
    const apiToken = await orca.secrets.get(KEYS.apiToken)
    return apiToken ? createCloudflareClient(apiToken) : null
  }

  async function startTunnel() {
    const blocked = blockReason()
    if (blocked) throw new UpdateRequired(blocked)
    const config = await settings()
    const { port } = await findOrcaWebSocketPort({ override: config.localPort })

    if (config.mode === 'worker') {
      use(bridge)
      let relay = await orca.storage.get(KEYS.worker)
      const hostKey = await orca.secrets.get(KEYS.hostKey)
      if (!relay?.workerUrl || !relay?.hostId || !hostKey) {
        throw new SetupRequired('Cloudflare Relay is not set up yet. Choose a connection type in Setup.')
      }
      relay = await adoptPairedIdentity(relay, hostKey)
      bridge.start({ workerUrl: relay.workerUrl, hostId: relay.hostId, hostKey, port })
      await orca.storage.set(KEYS.enabled, true)
      if (relay.deployedBy === 'button' && !relay.ownerClaimed) {
        claimButtonRelay(relay, hostKey).catch((error) => log(`Could not lock the relay Worker to this desktop: ${errorMessage(error)}`))
      }
      return
    }

    if (config.mode === 'custom') {
      use(custom)
      const saved = await orca.storage.get(KEYS.custom)
      if (!saved?.endpoint) throw new SetupRequired('Enter your own address in Setup first.')
      custom.start({ endpoint: saved.endpoint, port })
      await orca.storage.set(KEYS.enabled, true)
      return
    }

    use(tunnel)
    tunnel.setStatus({ state: 'starting', mode: config.mode, message: 'Preparing…' })
    const binary = await ensureCloudflared({
      cacheDir,
      override: config.cloudflaredPath || undefined,
      onProgress: (message) => tunnel.setStatus({ state: 'starting', message })
    })
    if (config.mode === 'named') {
      const named = await orca.storage.get(KEYS.named)
      const token = await orca.secrets.get(KEYS.tunnelToken)
      if (!named?.tunnelId || !token) {
        throw new SetupRequired('Your Cloudflare tunnel is not set up yet. Finish it in Setup.')
      }
      if (named.port !== port) {
        const request = await cloudflareRequest()
        if (request) {
          await updateTunnelPort({ request, ...named, port })
          await saveState(KEYS.named, { ...named, port })
        } else {
          log(`Orca now listens on ${port} but the tunnel targets ${named.port}; update the tunnel's service in Cloudflare.`)
          setTimeout(() => {
            if (tunnel.status.state === 'connected') {
              tunnel.setStatus({ message: `Orca now listens on port ${port}: change the tunnel's service in Cloudflare to http://127.0.0.1:${port}.` })
            }
          }, 8000).unref?.()
        }
      }
      tunnel.start({ binary, mode: 'named', port, token, host: named.hostname })
    } else {
      tunnel.start({ binary, mode: 'quick', port })
    }
    await orca.storage.set(KEYS.enabled, true)
  }

  /** Serialises start/stop/setup so double clicks cannot start two transports. */
  function exclusive(task) {
    const run = (busy ?? Promise.resolve()).then(task)
    // `busy` only orders tasks: it must never reject, or Orca kills the worker for an
    // unhandled rejection when no later task chains onto it.
    const settled = run.then(
      () => {},
      () => {}
    )
    busy = settled
    settled.then(() => {
      if (busy === settled) busy = null
    })
    return run
  }

  function fail(error, { needsSetup = error instanceof SetupRequired } = {}) {
    log(`Cloudflare Relay: ${errorMessage(error)}`)
    active.setStatus({ state: 'error', message: errorMessage(error), needsSetup })
  }

  function startInBackground() {
    return exclusive(startTunnel).catch(fail)
  }

  async function stopTunnel() {
    active.stop()
    await orca.storage.set(KEYS.enabled, false)
    await invalidatePairingCode('the relay stopped')
  }

  /** Paired phones for the panel: the count and names/dates only (no tokens or device ids). */
  async function pairedPhonesView() {
    const rows = await readDeviceRegistry().catch(() => [])
    return { pairedPhones: countPairedPhones(rows), pairedPhoneList: pairedPhoneList(rows) }
  }

  async function snapshot() {
    const config = await settings()
    const named = await orca.storage.get(KEYS.named)
    const relay = await orca.storage.get(KEYS.worker)
    const configured = await refreshConfigured(config)
    return {
      configured,
      status: currentStatus(),
      settings: config,
      named: named ? { hostname: named.hostname, tunnelName: named.tunnelName, zoneName: named.zoneName, manual: named.manual === true } : null,
      custom: (await orca.storage.get(KEYS.custom)) ?? null,
      orcaPort: (await findOrcaWebSocketPort({ override: config.localPort }).catch(() => ({ port: null }))).port,
      worker: relay ? { workerUrl: relay.workerUrl, deployedBy: relay.deployedBy, accountName: relay.accountName ?? null } : null,
      hasApiToken: Boolean(await orca.secrets.get(KEYS.apiToken)),
      orcaCliFound: Boolean(findOrcaCli({ override: config.orcaCliPath || undefined })),
      links: { createToken: TOKEN_TEMPLATE_URL, createTunnelToken: TUNNEL_TOKEN_TEMPLATE_URL, deployButton: DEPLOY_BUTTON_URL },
      updates: updatesView(),
      ...(await pairedPhonesView()),
      version: PLUGIN_VERSION,
      about: aboutInfo()
    }
  }

  async function saveApiToken(input) {
    if (typeof input?.apiToken === 'string' && input.apiToken.trim()) {
      await orca.secrets.set(KEYS.apiToken, input.apiToken.trim())
    }
  }

  /** Deploys the relay Worker (or adopts a Deploy-button one) and registers this desktop. */
  async function setupWorker(input) {
    const config = await settings()
    const previous = await orca.storage.get(KEYS.worker)
    const hostKey = (await orca.secrets.get(KEYS.hostKey)) ?? randomSecret(32)
    const usingWorkerUrl = typeof input?.workerUrl === 'string' && input.workerUrl.trim()
    if (!usingWorkerUrl && !(typeof input?.apiToken === 'string' && input.apiToken.trim()) && !(await orca.secrets.get(KEYS.apiToken))) {
      throw new Error(
        previous?.workerUrl
          ? 'Your relay is already set up; use Start. To redeploy or update it, create a Cloudflare token with the button above and paste it.'
          : 'Create a Cloudflare API token with the button above and paste it first.'
      )
    }
    use(bridge)
    let relay
    let adminToken = null
    if (usingWorkerUrl) {
      relay = { workerUrl: normalizeWorkerUrl(input.workerUrl), deployedBy: 'button' }
      // A Deploy-button Worker has no admin secret: this desktop's owner token claims it, so no
      // one else can register hosts on it.
      adminToken = (await orca.secrets.get(KEYS.adminToken)) ?? randomSecret()
    } else {
      await saveApiToken(input)
      const request = await cloudflareRequest()
      if (!request) throw new Error('Create a Cloudflare API token with the button above and paste it first.')
      bridge.setStatus({ state: 'starting', message: 'Deploying the relay Worker to your Cloudflare account…' })
      if (typeof input?.workerName === 'string' && input.workerName.trim()) {
        await orca.settings.set('workerName', validWorkerName(input.workerName))
      }
      const scriptName = (await settings()).workerName
      const accountId = (typeof input?.accountId === 'string' && input.accountId) || previous?.accountId || undefined
      const deployed = await deployRelayWorker({
        request,
        apiToken: await orca.secrets.get(KEYS.apiToken),
        scriptName,
        accountId,
        adminToken: await orca.secrets.get(KEYS.adminToken),
        // Redeploying the relay this desktop deployed is not a name clash.
        knownOurs: previous?.deployedBy === 'plugin' && previous.scriptName === scriptName && previous.accountId === accountId
      })
      log(`Deployed the relay Worker to ${deployed.workerUrl} (account ${deployed.accountName ?? deployed.accountId}).`)
      adminToken = deployed.adminToken
      await orca.secrets.set(KEYS.adminToken, adminToken)
      relay = {
        workerUrl: deployed.workerUrl,
        accountId: deployed.accountId,
        accountName: deployed.accountName,
        scriptName: deployed.scriptName,
        deployedBy: 'plugin'
      }
    }
    bridge.setStatus({ state: 'starting', message: `Waiting for ${new URL(relay.workerUrl).host} to come online…` })
    const health = await waitForRelay(relay.workerUrl)
    // Paired phones dial <worker>/v1/c/<hostId>: reuse the id this machine already registered on
    // this Worker (by any copy of the plugin), then this copy's own, so no phone has to pair again.
    const hostId = (await rememberedHostId(relay.workerUrl)) ?? previous?.hostId ?? randomSecret(16)
    bridge.setStatus({ state: 'starting', message: 'Registering this desktop with the relay…' })
    await registerRelayHost({ workerUrl: relay.workerUrl, hostId, hostKey, adminToken })
    await rememberHostId(relay.workerUrl, hostId).catch((error) => log(`Could not record the relay identity: ${errorMessage(error)}`))
    await orca.secrets.set(KEYS.hostKey, hostKey)
    if (usingWorkerUrl) await orca.secrets.set(KEYS.adminToken, adminToken)
    await saveState(KEYS.worker, {
      ...relay,
      hostId,
      relayVersion: health?.version ?? null,
      relayProtocol: health?.protocol ?? null,
      ...(usingWorkerUrl ? { ownerClaimed: locksOwner(health) } : {})
    })
    if (health?.version) relayState = { version: health.version, protocol: health.protocol ?? 1 }
    // Least privilege: the token can edit every Worker in the account and is only needed to
    // deploy, so forget it unless the user asked to keep it (Cloudflare can also revoke it).
    if (!config.keepApiToken) await orca.secrets.delete(KEYS.apiToken)
  }

  /**
   * Keeps the address paired phones know. Installs from before 2.6.0 record their host id here
   * on first start. When another copy of the plugin on this machine (a reinstall, a development
   * folder) registered a different id on the same Worker, phones were paired with that one, so
   * take it over by registering it with this copy's key. Falls back to this copy's own id when
   * the relay refuses (for example, the other copy redeployed with a newer admin secret).
   */
  async function adoptPairedIdentity(relay, hostKey) {
    const remembered = await rememberedHostId(relay.workerUrl).catch(() => null)
    if (!remembered) {
      await rememberHostId(relay.workerUrl, relay.hostId, { ifAbsent: true }).catch((error) => log(`Could not record the relay identity: ${errorMessage(error)}`))
      return relay
    }
    if (remembered === relay.hostId) return relay
    const adminToken = await orca.secrets.get(KEYS.adminToken)
    try {
      await registerRelayHost({ workerUrl: relay.workerUrl, hostId: remembered, hostKey, adminToken, timeoutMs: 15_000 })
    } catch (error) {
      log(`Phones paired through another copy of this plugin use a different relay address; keeping this copy's own (${errorMessage(error)}). Run setup again to take it over.`)
      return relay
    }
    const adopted = { ...relay, hostId: remembered }
    await saveState(KEYS.worker, adopted)
    log('Switched to the relay address your paired phones already use.')
    return adopted
  }

  /** Relay 1.2.0+ locks a Deploy-button Worker to the first owner token it sees. */
  function locksOwner(health) {
    return health?.service === 'orca-cloudflare-relay' && compareVersions(String(health.version ?? '0'), '1.2.0') >= 0
  }

  /**
   * Deploy-button relays set up before relay 1.2.0 accepted registrations from anyone. Once the
   * Worker is updated, re-registering with an owner token locks it to this desktop.
   */
  async function claimButtonRelay(relay, hostKey) {
    const health = await fetch(`${relay.workerUrl}/health`, { cache: 'no-store' }).then((response) => response.json()).catch(() => null)
    if (!locksOwner(health)) return
    const ownerToken = (await orca.secrets.get(KEYS.adminToken)) ?? randomSecret()
    await registerRelayHost({ workerUrl: relay.workerUrl, hostId: relay.hostId, hostKey, adminToken: ownerToken, timeoutMs: 20_000 })
    await orca.secrets.set(KEYS.adminToken, ownerToken)
    const current = await orca.storage.get(KEYS.worker)
    if (current?.hostId === relay.hostId) await saveState(KEYS.worker, { ...current, ownerClaimed: true })
    log('Locked the relay Worker to this desktop.')
  }

  async function setupNamed(input) {
    const hostname = normalizeHostname(input?.hostname)
    if (typeof input?.tunnelToken === 'string' && input.tunnelToken.trim()) {
      // Manual: the person created the tunnel and its public hostname in Cloudflare themselves;
      // the plugin only runs cloudflared with that tunnel's token (no API token at all).
      const parsed = parseTunnelToken(input.tunnelToken)
      const config = await settings()
      const { port } = await findOrcaWebSocketPort({ override: config.localPort })
      await orca.secrets.set(KEYS.tunnelToken, parsed.token)
      await saveState(KEYS.named, { hostname, tunnelId: parsed.tunnelId, accountId: parsed.accountId, port, manual: true, tunnelName: '(created in Cloudflare)' })
      await orca.settings.set('hostname', hostname)
      return
    }
    await saveApiToken(input)
    const request = await cloudflareRequest()
    if (!request) throw new Error('Paste a Cloudflare API token first.')
    const config = await settings()
    const { port } = await findOrcaWebSocketPort({ override: config.localPort })
    use(tunnel)
    tunnel.setStatus({ state: 'starting', mode: 'named', message: `Creating tunnel for ${hostname}…` })
    const result = await provisionNamedTunnel({ request, hostname, tunnelName: config.tunnelName, port })
    await orca.secrets.set(KEYS.tunnelToken, result.token)
    const { token: _token, ...stored } = result
    await saveState(KEYS.named, { ...stored, port })
    await orca.settings.set('hostname', hostname)
  }

  /**
   * The relay and tunnel keys live in Orca's encrypted secrets file, which needs an OS key store.
   * Without one (`secrets.protection` is `unavailable`, such as Linux `basic_text`) `secrets.set`
   * fails, so say why up front instead of failing halfway through a deploy.
   */
  async function requireSecretStore() {
    if (!orca.host.has?.('secrets.protection')) return
    const protection = await orca.host.call('secrets.protection', {}).catch(() => null)
    if (protection?.status === 'unavailable') {
      throw new Error(
        'Orca cannot store secrets on this computer because no OS key store is available (on Linux, install and unlock a keyring such as GNOME Keyring or KWallet, then restart Orca). The relay keys must be stored encrypted, so setup stopped.'
      )
    }
  }

  async function setup(input) {
    const mode = MODES.includes(input?.mode) ? input.mode : 'worker'
    await orca.settings.set('mode', mode)
    if (typeof input?.relayFallback === 'boolean') await orca.settings.set('relayFallback', input.relayFallback)
    if (mode === 'worker' || mode === 'named') await requireSecretStore()
    if (mode === 'worker') await setupWorker(input)
    if (mode === 'named') await setupNamed(input)
    if (mode === 'custom') {
      await orca.storage.set(KEYS.custom, { endpoint: normalizeCustomEndpoint(input?.endpoint) })
    }
    await startTunnel()
    await orca.storage.set(KEYS.setupComplete, true)
    await refreshConfigured()
  }

  async function removeSetup() {
    active.stop()
    await orca.storage.set(KEYS.enabled, false)
    const config = await settings()
    if (config.mode === 'named') {
      const named = await orca.storage.get(KEYS.named)
      if (named?.tunnelId && !named.manual) {
        const request = await cloudflareRequest()
        if (!request) throw new Error('The Cloudflare API token is needed to delete the tunnel.')
        await deleteNamedTunnel({ request, ...named })
      }
      await orca.storage.delete(KEYS.named)
      await orca.secrets.delete(KEYS.tunnelToken)
    }
    if (config.mode === 'custom') await orca.storage.delete(KEYS.custom)
    if (config.mode === 'worker') {
      const relay = await orca.storage.get(KEYS.worker)
      if (relay?.deployedBy === 'plugin' && relay.accountId && relay.scriptName) {
        const request = await cloudflareRequest()
        if (request) {
          await request('DELETE', `/accounts/${relay.accountId}/workers/scripts/${relay.scriptName}?force=true`)
        } else {
          // Without a token the Worker stays, but this desktop's key is forgotten below, so the
          // relay can no longer reach this Orca. Delete the Worker in the dashboard if wanted.
          log(`Forgot this desktop's relay key; the Worker ${relay.scriptName} remains in your Cloudflare account.`)
        }
      }
      await orca.storage.delete(KEYS.worker)
      await orca.secrets.delete(KEYS.hostKey)
      await orca.secrets.delete(KEYS.adminToken)
    }
    await orca.secrets.delete(KEYS.apiToken)
    await orca.storage.delete(KEYS.setupComplete)
    await refreshConfigured()
  }

  /**
   * Mints a fresh single-use pairing code. Every "show" rotates, so at most one unused code
   * exists, and it is invalidated after PAIRING_CODE_TTL_MS. Phones that already paired keep
   * their own long-term credentials.
   */
  async function pairingOffer() {
    const status = currentStatus()
    if (status.state !== 'connected' || !status.endpoint) {
      throw new Error('Start Cloudflare Relay and wait until it is connected.')
    }
    const config = await settings()
    const offer = await createMobilePairingOffer({
      cli: findOrcaCli({ override: config.orcaCliPath || undefined }),
      endpoint: status.endpoint,
      relayFallback: config.relayFallback,
      rotate: true
    })
    stopWatchingCode()
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
    shownCode = {
      endpoint: status.endpoint,
      timer: setTimeout(() => {
        invalidatePairingCode('the pairing code expired').catch((error) => log(`Could not invalidate the pairing code: ${errorMessage(error)}`))
      }, PAIRING_CODE_TTL_MS),
      watch: null
    }
    shownCode.timer.unref?.()
    watchForPairing(shownCode, pairingDeviceToken(offer.pairingUrl))
    // The panel gets the QR image only; the link itself never leaves this process.
    return { endpoint: offer.endpoint, connectionMode: offer.connectionMode, expiresAt, svg: qrSvg(offer.pairingUrl) }
  }

  function stopWatchingCode() {
    clearTimeout(shownCode?.timer)
    clearInterval(shownCode?.watch)
  }

  /**
   * Takes the code off the screen as soon as a phone signs in with it: from then on Orca's
   * single-use ticket belongs to that phone, and nothing on screen is worth photographing.
   */
  function watchForPairing(code, deviceToken) {
    if (!deviceToken) return
    let deviceId = null
    code.watch = setInterval(async () => {
      const row = pairingRowFor(await readDeviceRegistry(), deviceId ? { deviceId } : { deviceToken })
      if (shownCode !== code || !row) return
      deviceId = row.deviceId
      if (!row.paired) return
      stopWatchingCode()
      shownCode = null
      log('A phone paired through Cloudflare Relay; the pairing code was removed from the screen.')
      orca.panels.post('pairing-complete', await pairedPhonesView())
    }, PAIRING_WATCH_INTERVAL_MS)
    code.watch.unref?.()
  }

  /** Replaces the unused code on screen with one nobody has seen, so a photo of it is useless. */
  async function invalidatePairingCode(reason) {
    if (!shownCode) return
    const { endpoint } = shownCode
    stopWatchingCode()
    shownCode = null
    orca.panels.post('pairing-invalidated', { reason })
    const config = await settings()
    const cli = findOrcaCli({ override: config.orcaCliPath || undefined })
    if (!cli) return
    await createMobilePairingOffer({ cli, endpoint, relayFallback: config.relayFallback, rotate: true }).catch((error) =>
      log(`Could not rotate the pairing code: ${errorMessage(error)}`)
    )
  }

  /** Author and links for the panel footer, straight from the manifest. */
  function aboutInfo() {
    const repository = typeof MANIFEST.repository === 'string' && MANIFEST.repository.startsWith('https://') ? MANIFEST.repository : null
    return {
      name: MANIFEST.name ?? 'Cloudflare Relay',
      version: PLUGIN_VERSION,
      author: MANIFEST.author?.name ?? null,
      authorUrl: typeof MANIFEST.author?.url === 'string' && MANIFEST.author.url.startsWith('https://') ? MANIFEST.author.url : null,
      repository,
      issues: repository && repository.startsWith('https://github.com/') ? `${repository.replace(/\/$/, '')}/issues` : null
    }
  }

  // ---------------------------------------------------------------- updates

  function updatesView() {
    return { checkedAt: updates.checkedAt, error: updates.error, plugin: updates.plugin, relay: updates.relay }
  }

  function publishUpdates() {
    orca.panels.post('updates', updatesView())
    renderStatusBar(currentStatus())
  }

  /** Version of the deployed relay Worker, from its public health endpoint. */
  async function relayHealth(workerUrl) {
    const response = await fetch(`${workerUrl}/health?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const payload = await response.json().catch(() => null)
    return payload?.service === 'orca-cloudflare-relay' ? { version: payload.version, protocol: payload.protocol ?? 1 } : null
  }


  async function loadRequired() {
    const stored = (await orca.storage.get(KEYS.required)) ?? {}
    required = { plugin: higherMinimum(required.plugin, stored.plugin), relay: higherMinimum(required.relay, stored.relay) }
    const relay = await orca.storage.get(KEYS.worker)
    if (!relayState && relay?.relayVersion) relayState = { version: relay.relayVersion, protocol: relay.relayProtocol ?? 1 }
  }

  async function raiseRequired(info) {
    const next = { plugin: higherMinimum(required.plugin, info?.plugin?.minimum), relay: higherMinimum(required.relay, info?.relay?.minimum) }
    if (next.plugin !== required.plugin || next.relay !== required.relay) {
      required = next
      await saveState(KEYS.required, required)
    }
  }

  /**
   * Why the relay must stay off, or null. A plugin version below the published minimum has a
   * known security problem (development copies are exempt); so does a relay Worker below its
   * minimum or on an older protocol. Fail closed: phones can't reach this desktop until fixed.
   */
  function blockReason() {
    const plugin = updates.plugin
    if (belowMinimum(PLUGIN_VERSION, required.plugin) && !plugin?.isDev && plugin?.status !== 'updated') {
      return `This version of Cloudflare Relay (${PLUGIN_VERSION}) has a known security problem, so the relay is off. Update to ${required.plugin} or newer: click Update now in the Cloudflare Relay panel.`
    }
    if (currentMode !== 'worker' || !relayState?.version) return null
    const relayRequired = belowMinimum(relayState.version, required.relay) || !(relayState.protocol >= MIN_RELAY_PROTOCOL)
    if (!relayRequired) return null
    if (belowMinimum(bundledRelayInfo().version, required.relay)) {
      return `The relay Worker in your Cloudflare account (${relayState.version}) has a known security problem, so the relay is off. Update the plugin first: it brings the fixed Worker.`
    }
    return `The relay Worker in your Cloudflare account (${relayState.version}) must be updated before it can be used again, so the relay is off. Click Update relay in the Cloudflare Relay panel (it keeps your phones paired).`
  }

  /** Stops a running relay that became unsafe, and resumes it once the problem is fixed. */
  function enforceRequired() {
    const blocked = blockReason()
    if (blocked && !blockedNow) {
      blockedNow = true
      if (active.wanted || active.status.state !== 'stopped') {
        // Not stopTunnel(): the relay stays "on" for the person and resumes after the update.
        active.stop({ silent: true })
        fail(new UpdateRequired(blocked))
      }
    } else if (!blocked && blockedNow) {
      blockedNow = false
      const idle = active.status.state === 'stopped' || active.status.state === 'error'
      if (idle) orca.storage.get(KEYS.enabled).then((on) => on === true && startInBackground()).catch(() => {})
    }
    renderStatusBar(currentStatus())
  }

  /** Is a newer plugin published, and is this version still allowed? */
  async function checkPluginRelease(config, info) {
    const latest = info?.plugin?.latest ?? required.plugin
    if (!latest || compareVersions(latest, PLUGIN_VERSION) <= 0) return { available: false, current: PLUGIN_VERSION, latest: latest ?? PLUGIN_VERSION }
    const cli = findOrcaCli({ override: config.orcaCliPath || undefined })
    ownKey ??= cli ? await findOwnPluginKey({ cli, pluginId: MANIFEST.id, version: PLUGIN_VERSION }).catch(() => null) : null
    const keep = updates.plugin?.latest === latest ? { status: updates.plugin.status, added: updates.plugin.added, message: updates.plugin.message } : { status: 'idle' }
    return {
      available: true,
      mandatory: belowMinimum(PLUGIN_VERSION, required.plugin),
      current: PLUGIN_VERSION,
      latest,
      notes: info?.plugin?.notes ?? '',
      pluginKey: ownKey,
      isDev: Boolean(ownKey?.startsWith('local.')),
      ...keep
    }
  }

  /** Update now: Orca's own updater, started by the person's click. */
  async function updatePluginNow() {
    const plugin = updates.plugin
    if (!plugin?.available) throw new Error('This is already the newest version.')
    if (plugin.isDev) throw new Error('This is a development copy: pull the repository to update it.')
    const config = await settings()
    const cli = findOrcaCli({ override: config.orcaCliPath || undefined })
    ownKey ??= cli ? await findOwnPluginKey({ cli, pluginId: MANIFEST.id, version: PLUGIN_VERSION }).catch(() => null) : null
    if (!cli || !ownKey) throw new Error('Orca could not be reached from the plugin. Update it in Orca Settings → Plugins instead.')
    updates.plugin = { ...plugin, status: 'installing', message: null }
    publishUpdates()
    try {
      const outcome = await runPluginUpdate({ cli, pluginKey: ownKey })
      updates.plugin = outcome.status === 'approval_required'
        ? { ...updates.plugin, status: 'approval_required', added: outcome.added }
        : outcome.status === 'updated'
          ? { ...updates.plugin, status: 'updated' }
          : { ...updates.plugin, status: 'failed', message: `Orca answered "${outcome.status}": the new version may not be published yet. Try again later.` }
    } catch (error) {
      updates.plugin = { ...updates.plugin, status: 'failed', message: errorMessage(error) }
    }
    publishUpdates()
    return updatesView()
  }

  /** Compares the deployed relay Worker with the bundled one, and looks for a newer plugin. */
  async function checkForUpdates({ apply = true } = {}) {
    const config = await settings()
    const relay = config.mode === 'worker' ? await orca.storage.get(KEYS.worker) : null
    updates.error = null
    currentMode = config.mode
    await loadRequired()
    const url = updateManifestUrl(MANIFEST.repository)
    const info = url ? await fetchReleaseInfo(url).catch(() => null) : null
    await raiseRequired(info)
    updates.plugin = await checkPluginRelease(config, info).catch(() => updates.plugin)
    if (relay?.workerUrl) {
      const deployed = await relayHealth(relay.workerUrl).catch((error) => {
        updates.error = `Could not reach the relay Worker: ${errorMessage(error)}`
        return null
      })
      if (deployed) {
        relayState = deployed
        if (relay.relayVersion !== deployed.version) await saveState(KEYS.worker, { ...relay, relayVersion: deployed.version, relayProtocol: deployed.protocol })
        const evaluated = evaluateRelayUpdate({ deployed, bundled: bundledRelayInfo(), minProtocol: MIN_RELAY_PROTOCOL, minimum: required.relay })
        const keep = updates.relay?.latest === evaluated.latest && updates.relay?.deployed === evaluated.deployed
          ? { status: updates.relay.status, message: updates.relay.message }
          : { status: 'idle', message: null }
        updates.relay = { ...evaluated, ...keep, deployedBy: relay.deployedBy }
      }
    } else {
      updates.relay = null
    }
    updates.checkedAt = Date.now()
    publishUpdates()
    enforceRequired()
    if (apply) await applyUpdatePolicies(config)
    return updatesView()
  }

  async function applyUpdatePolicies(config) {
    const relay = updates.relay
    // A required relay update deploys by itself (default policy) when a token is kept; it can only
    // deploy the Worker this plugin ships, so one that needs a newer plugin waits for it.
    if (relay && relay.status === 'idle' && relay.deployedBy === 'plugin' && !relay.needsPlugin && shouldAutoInstall(config.relayUpdates, relay) && (await orca.secrets.get(KEYS.apiToken))) {
      await updateRelay().catch((error) => log(`Automatic relay update failed: ${errorMessage(error)}`))
    }
  }

  /** Redeploys the bundled relay Worker; same host id and keys, so phones stay paired. */
  async function updateRelay(input) {
    await saveApiToken(input)
    if (!(await orca.secrets.get(KEYS.apiToken))) {
      throw new Error('Updating the relay needs a Cloudflare token. Create one with the button in Setup and paste it.')
    }
    updates.relay = { ...updates.relay, status: 'installing', message: 'Deploying the new relay version…' }
    publishUpdates()
    try {
      await exclusive(async () => {
        await setupWorker({ mode: 'worker' })
        await startTunnel()
      })
      updates.relay = { ...updates.relay, status: 'idle', message: null }
      await checkForUpdates({ apply: false })
    } catch (error) {
      updates.relay = { ...updates.relay, status: 'failed', message: errorMessage(error) }
      publishUpdates()
      throw error
    }
    return updatesView()
  }

  function handle(name, task) {
    orca.panels.handle(name, async (input) => {
      try {
        return { ok: true, ...(await task(input)) }
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          // Structured follow-ups the panel can ask about instead of a dead-end message.
          ...(error instanceof AccountChoiceRequired ? { needs: 'account', accounts: error.accounts } : {}),
          ...(error instanceof WorkerNameTaken ? { needs: 'worker-name' } : {}),
          ...(await snapshot().catch(() => ({})))
        }
      }
    })
  }

  handle('status', snapshot)
  handle('setup', async (input) => {
    await exclusive(() => setup(input)).catch((error) => {
      // A rejected setup (e.g. no token pasted) must not mark a still-running relay as failed.
      // A follow-up question (which account? another name?) is not a failure of the relay.
      const question = error instanceof AccountChoiceRequired || error instanceof WorkerNameTaken
      if (question && !active.wanted) active.setStatus({ state: 'stopped', message: null })
      else if (!active.wanted) fail(error, { needsSetup: true })
      throw error
    })
    return snapshot()
  })
  handle('start', async () => {
    startInBackground()
    return snapshot()
  })
  handle('stop', async () => {
    await exclusive(stopTunnel)
    return snapshot()
  })
  handle('pair', pairingOffer)
  handle('check-updates', () => checkForUpdates())
  handle('update-plugin', async () => ({ updates: await updatePluginNow() }))
  handle('update-relay', async (input) => ({ updates: await updateRelay(input) }))
  handle('verify-token', async (input) => {
    const candidate = typeof input?.apiToken === 'string' && input.apiToken.trim()
    const token = candidate || (await orca.secrets.get(KEYS.apiToken))
    if (!token) return { valid: false, status: 'missing' }
    const relay = await orca.storage.get(KEYS.worker)
    const named = await orca.storage.get(KEYS.named)
    return verifyCloudflareToken(createCloudflareClient(token), relay?.accountId ?? named?.accountId)
  })
  handle('invalidate-pairing', async () => {
    await invalidatePairingCode('you hid the pairing code')
    return {}
  })
  handle('remove', async (input) => {
    await saveApiToken(input)
    await exclusive(removeSetup)
    return snapshot()
  })

  orca.commands.register('cloudflare-relay.start', async () => {
    await startInBackground()
    return active.status.state === 'error'
      ? `Cloudflare Relay failed: ${active.status.message}`
      : 'Cloudflare Relay is starting. Open the Cloudflare Relay panel to pair your phone.'
  })
  orca.commands.register('cloudflare-relay.stop', async () => {
    await exclusive(stopTunnel)
    return 'Cloudflare Relay stopped.'
  })
  orca.commands.register('cloudflare-relay.toggle', async () => {
    if (active.status.state === 'stopped' || active.status.state === 'error') {
      startInBackground()
      return 'Cloudflare Relay is starting.'
    }
    await exclusive(stopTunnel)
    return 'Cloudflare Relay stopped.'
  })
  async function openPanel() {
    const config = await settings()
    const cli = findOrcaCli({ override: config.orcaCliPath || undefined })
    if (!cli) throw new Error('the Orca CLI was not found')
    try {
      ownKey ??= await findOwnPluginKey({ cli, pluginId: MANIFEST.id, version: PLUGIN_VERSION })
      if (!ownKey) throw new Error('this plugin was not found in `orca plugin list`')
      await openPluginPanel({ cli, pluginKey: ownKey, panel: PANEL_ID })
    } catch (error) {
      ownKey = null
      throw error
    }
  }
  orca.commands.register('cloudflare-relay.openPanel', async () => {
    try {
      await openPanel()
      return undefined
    } catch (error) {
      return `Open the Cloudflare Relay panel from the right sidebar (${errorMessage(error)}).`
    }
  })

  // First run after install: show the setup panel once, so nobody has to hunt for it.
  ;(async () => {
    if (await refreshConfigured()) return
    if ((await orca.storage.get(KEYS.welcomed)) === true) return
    await new Promise((resolve) => updateTimers.push(setTimeout(resolve, 3000)))
    await openPanel()
    await orca.storage.set(KEYS.welcomed, true)
  })().catch((error) => log(`Could not open the setup panel automatically: ${errorMessage(error)}`))
  orca.commands.register('cloudflare-relay.status', async () => {
    const status = currentStatus()
    return status.state === 'connected'
      ? `Cloudflare Relay is connected: ${status.endpoint} → 127.0.0.1:${status.port}`
      : `Cloudflare Relay is ${status.state}${status.message ? `: ${status.message}` : ''}`
  })

  // Check the relay Worker shortly after start, then periodically (the worker stays resident).
  const runCheck = () => checkForUpdates().catch((error) => log(`Update check failed: ${errorMessage(error)}`))
  updateTimers.push(setTimeout(runCheck, 15_000), setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS))

  // Resume with Orca when the user left it on.
  ;(async () => {
    const config = await settings()
    // Known minimums first, so a version with a known security problem never starts, even offline.
    await loadRequired()
    blockedNow = Boolean(blockReason())
    renderStatusBar(currentStatus())
    if (config.autoStart && (await orca.storage.get(KEYS.enabled)) === true) {
      await startInBackground()
      // A host call can fail transiently while Orca is still settling a (re)loaded plugin's
      // consent; retry once rather than leaving the relay in an error state.
      if (active.status.state === 'error' && !active.status.needsSetup && !blockReason()) {
        await new Promise((resolve) => updateTimers.push(setTimeout(resolve, 5000)))
        await startInBackground()
      }
    }
  })().catch((error) => log(`Cloudflare Relay auto-start skipped: ${errorMessage(error)}`))

  log('Cloudflare Relay loaded.')
}

export function deactivate() {
  for (const timer of updateTimers) clearTimeout(timer)
  updateTimers = []
  // The unused code dies with the desktop process anyway; nothing to rotate here.
  tunnel?.stop({ silent: true })
  bridge?.stop({ silent: true })
  custom?.stop({ silent: true })
}
