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
 * the bridge speaks.
 */
export function evaluateRelayUpdate({ deployed, bundled, minProtocol }) {
  if (!deployed?.version || !bundled?.version) return { available: false, mandatory: false, deployed: deployed?.version ?? null, latest: bundled?.version ?? null }
  const protocolTooOld = !(deployed.protocol >= minProtocol)
  const newer = compareVersions(bundled.version, deployed.version) > 0
  return { available: newer || protocolTooOld, mandatory: protocolTooOld, deployed: deployed.version, latest: bundled.version }
}
