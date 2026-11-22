import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** How often a running plugin compares the deployed relay Worker with the bundled one. */
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

/** raw.githubusercontent.com URL of `update-manifest.json` for a GitHub repository URL. */
export function updateManifestUrl(repository, branch = 'main') {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(repository ?? ''))
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/update-manifest.json`
}

const VERSION = /^v?\d+\.\d+\.\d+/
const clean = (value) => (typeof value === 'string' && VERSION.test(value) ? value.replace(/^v/, '') : null)

/**
 * The published release info (`update-manifest.json`): the newest plugin and relay versions, and
 * each one's `minimum`. Anything older than a minimum has a known security or compatibility
 * problem. This only informs: installing the plugin stays Orca's job (or the person's click).
 */
export async function fetchReleaseInfo(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(`${url}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json().catch(() => null)
  const section = (raw) => {
    const latest = clean(raw?.latest)
    if (!latest) return null
    return { latest, minimum: requiredMinimum(raw.minimum, latest), notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 600) : '' }
  }
  const plugin = section(body?.plugin)
  if (!plugin) throw new Error('no version published')
  return { plugin, relay: section(body?.relay) }
}

/**
 * A minimum counts only when a version that meets it is published: a required update must
 * always have an update to install, so a bad entry can't switch relays off with no way back.
 */
export function requiredMinimum(minimum, latest) {
  const value = clean(minimum)
  return value && clean(latest) && compareVersions(value, latest) <= 0 ? value : null
}

/** The higher of two minimums (a known minimum is never lowered, even offline). */
export function higherMinimum(a, b) {
  if (!clean(a)) return clean(b)
  if (!clean(b)) return clean(a)
  return compareVersions(a, b) >= 0 ? clean(a) : clean(b)
}

/** Whether `current` is below a required minimum. */
export function belowMinimum(current, minimum) {
  return Boolean(clean(minimum) && clean(current) && compareVersions(current, minimum) < 0)
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
 * The deployed relay compared with the bundled one. Required when its protocol is older than the
 * bridge speaks, or its version is below the published minimum (a known security problem).
 * `needsPlugin`: the bundled Worker doesn't meet the minimum yet, so the plugin must update first.
 */
export function evaluateRelayUpdate({ deployed, bundled, minProtocol, minimum = null }) {
  if (!deployed?.version || !bundled?.version) return { available: false, mandatory: false, deployed: deployed?.version ?? null, latest: bundled?.version ?? null }
  const protocolTooOld = !(deployed.protocol >= minProtocol)
  const insecure = belowMinimum(deployed.version, minimum)
  const newer = compareVersions(bundled.version, deployed.version) > 0
  return {
    available: newer || protocolTooOld || insecure,
    mandatory: protocolTooOld || insecure,
    needsPlugin: insecure && belowMinimum(bundled.version, minimum),
    deployed: deployed.version,
    latest: bundled.version
  }
}
