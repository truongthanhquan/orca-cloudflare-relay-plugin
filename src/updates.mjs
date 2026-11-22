import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** How often a running plugin looks for new versions. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const UPDATE_POLICIES = ['all', 'mandatory', 'off']

/** Numeric x.y.z comparison (pre-release suffixes are ignored). */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1
  }
  return 0
}

function isVersion(value) {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+/.test(value)
}

/** raw.githubusercontent.com URL of `update-manifest.json` for a GitHub repository URL. */
export function updateManifestUrl(repository, branch = 'main') {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(repository ?? ''))
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/update-manifest.json`
}

/**
 * The published update manifest:
 * { schema: 1, plugin: { latest, minimum, notes }, relay: { latest, minimum, notes } }.
 * `minimum` marks a required update: anything older must update (security or breaking fix).
 */
export function parseUpdateManifest(value) {
  if (value?.schema !== 1 || !isVersion(value?.plugin?.latest)) throw new Error('Unrecognised update manifest.')
  const section = (raw) =>
    raw && isVersion(raw.latest)
      ? {
          latest: raw.latest.replace(/^v/, ''),
          minimum: isVersion(raw.minimum) ? raw.minimum.replace(/^v/, '') : null,
          notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : ''
        }
      : null
  return { plugin: section(value.plugin), relay: section(value.relay) }
}

export async function fetchUpdateManifest(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(`${url}?t=${Date.now()}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (response.status === 404) throw new Error('no update information is published yet')
  if (!response.ok) throw new Error(`update server answered HTTP ${response.status}`)
  return parseUpdateManifest(await response.json())
}

/** What an installed version should do given the published section. */
export function evaluateUpdate(current, section) {
  if (!section || !isVersion(current)) return { available: false, mandatory: false, latest: section?.latest ?? null, notes: '' }
  const available = compareVersions(section.latest, current) > 0
  const mandatory = Boolean(section.minimum) && compareVersions(current, section.minimum) < 0
  return { available: available || mandatory, mandatory, latest: section.latest, minimum: section.minimum, notes: section.notes }
}

/** Whether a policy installs this update without asking. */
export function shouldAutoInstall(policy, update) {
  if (!update?.available) return false
  if (policy === 'all') return true
  if (policy === 'mandatory') return update.mandatory
  return false
}

/** RELAY_VERSION / RELAY_PROTOCOL of the Worker source shipped inside this plugin. */
export function bundledRelayInfo(sourcePath = fileURLToPath(new URL('../worker/src/index.js', import.meta.url))) {
  const source = readFileSync(sourcePath, 'utf8')
  const version = /const RELAY_VERSION = '([^']+)'/.exec(source)?.[1] ?? null
  const protocol = Number(/const RELAY_PROTOCOL = (\d+)/.exec(source)?.[1] ?? 0)
  return { version, protocol }
}

/**
 * The deployed relay compared with the bundled one. Required when its protocol is older than
 * the bridge speaks, or the published manifest marks its version as below the minimum.
 */
export function evaluateRelayUpdate({ deployed, bundled, minProtocol, published }) {
  if (!deployed?.version || !bundled?.version) return { available: false, mandatory: false, deployed: deployed?.version ?? null, latest: bundled?.version ?? null }
  const protocolTooOld = !(deployed.protocol >= minProtocol)
  const belowMinimum = Boolean(published?.minimum) && compareVersions(deployed.version, published.minimum) < 0
  const newer = compareVersions(bundled.version, deployed.version) > 0
  // The plugin can only deploy the Worker it ships; a newer published one needs a plugin update first.
  return {
    available: newer || protocolTooOld,
    mandatory: protocolTooOld || (belowMinimum && newer),
    deployed: deployed.version,
    latest: bundled.version,
    notes: published && compareVersions(published.latest, deployed.version) > 0 ? published.notes : ''
  }
}
