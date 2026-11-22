import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { orcaUserDataDir } from './paths.mjs'

export const DEFAULT_ORCA_WS_PORT = 6768

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

/** Port of a `ws://host:port` transport endpoint from orca-runtime.json. */
export function portFromRuntimeMetadata(metadata) {
  const transports = Array.isArray(metadata?.transports)
    ? metadata.transports
    : metadata?.transport
      ? [metadata.transport]
      : []
  const websocket = transports.find((item) => item?.kind === 'websocket')
  if (typeof websocket?.endpoint !== 'string') return null
  try {
    const url = new URL(websocket.endpoint)
    return validPort(Number(url.port || (url.protocol === 'wss:' ? 443 : 80)))
  } catch {
    return null
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The local port of the desktop's mobile/runtime WebSocket server — the same server LAN
 * pairing points phones at. Order: explicit override, the running app's runtime metadata,
 * the persisted fallback port, then Orca's default.
 */
export async function findOrcaWebSocketPort({ override, userDataDir = orcaUserDataDir() } = {}) {
  const explicit = validPort(Number(override))
  if (explicit) return { port: explicit, source: 'setting' }
  const fromRuntime = portFromRuntimeMetadata(await readJson(join(userDataDir, 'orca-runtime.json')))
  if (fromRuntime) return { port: fromRuntime, source: 'runtime' }
  const fallback = validPort((await readJson(join(userDataDir, 'mobile-ws-fallback-port.json')))?.port)
  if (fallback) return { port: fallback, source: 'fallback' }
  return { port: DEFAULT_ORCA_WS_PORT, source: 'default' }
}

/** Candidate locations of the bundled `orca` CLI, most specific first. */
export function orcaCliCandidates({
  platform = process.platform,
  execPath = process.execPath,
  pathEnv = process.env.PATH ?? '',
  home = process.env.HOME ?? process.env.USERPROFILE ?? ''
} = {}) {
  const names =
    platform === 'win32' ? ['orca.exe', 'orca.cmd'] : platform === 'linux' ? ['orca-ide', 'orca'] : ['orca']
  const execDir = dirname(execPath)
  const resourceBins =
    platform === 'darwin'
      ? [resolve(execDir, '..', 'Resources', 'bin')]
      : [resolve(execDir, 'resources', 'bin')]
  const extra =
    platform === 'darwin'
      ? ['/Applications/Orca.app/Contents/Resources/bin', join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
      : platform === 'linux'
        ? [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/Orca/resources/bin']
        : [join(home, 'AppData', 'Local', 'Programs', 'Orca', 'resources', 'bin')]
  const dirs = [...resourceBins, ...pathEnv.split(delimiter).filter(Boolean), ...extra]
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (!seen.has(candidate)) {
        seen.add(candidate)
        out.push(candidate)
      }
    }
  }
  return out
}

export function findOrcaCli(options = {}) {
  if (options.override && existsSync(options.override)) return options.override
  return orcaCliCandidates(options).find((candidate) => existsSync(candidate)) ?? null
}

function runCli(cli, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(cli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: cli.endsWith('.cmd')
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectDone(new Error('The Orca CLI did not answer in time.'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectDone(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveDone({ code, stdout, stderr })
    })
  })
}

/** Extracts the RPC result from `orca … --json` output. */
export function parseCliJson(stdout) {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('The Orca CLI returned no JSON.')
  const payload = JSON.parse(stdout.slice(start))
  if (payload?.ok === false) {
    const error = payload.error ?? {}
    throw new Error(error.message ?? error.code ?? 'The Orca CLI reported an error.')
  }
  return payload?.result ?? payload
}

/**
 * Asks the running Orca for a normal mobile pairing offer whose direct endpoint is the
 * Cloudflare hostname. The phone scans it exactly like a LAN QR code; the offer keeps
 * Orca's E2EE key pinning, so Cloudflare only ever forwards ciphertext.
 */
export async function createMobilePairingOffer({ cli, endpoint, relayFallback = false, rotate = false }) {
  if (!cli) {
    throw new Error('The Orca CLI was not found. Install it from Orca Settings → CLI, or set "Orca CLI path".')
  }
  const args = ['pair', '--mobile', '--address', endpoint, '--json']
  if (relayFallback) args.push('--relay')
  if (rotate) args.push('--rotate')
  const { code, stdout, stderr } = await runCli(cli, args)
  let result
  try {
    result = parseCliJson(stdout)
  } catch (error) {
    if (code !== 0) throw new Error((stderr || stdout || `orca pair exited ${code}`).trim())
    throw error
  }
  if (!result?.available) {
    throw new Error(`Pairing is unavailable (${result?.reason ?? 'unknown'}). ${result?.guidance ?? ''}`.trim())
  }
  return {
    pairingUrl: result.pairingUrl,
    endpoint: result.endpoint,
    connectionMode: result.connectionMode ?? null
  }
}

/**
 * This plugin's key on the Orca host (`local.cloudflare-relay` while developing,
 * `<publisher>.cloudflare-relay` when installed): the running entry, preferring our version.
 */
export async function findOwnPluginKey({ cli, pluginId = 'cloudflare-relay', version } = {}) {
  const { stdout } = await runCli(cli, ['plugin', 'list', '--json'], { timeoutMs: 15_000 })
  return pickOwnPluginKey(parseCliJson(stdout), { pluginId, version })
}

export function pickOwnPlugin(result, { pluginId = 'cloudflare-relay', version } = {}) {
  const plugins = Array.isArray(result) ? result : Array.isArray(result?.plugins) ? result.plugins : []
  const ours = plugins.filter((plugin) => typeof plugin?.pluginKey === 'string' && plugin.pluginKey.endsWith(`.${pluginId}`))
  const running = ours.filter((plugin) => plugin.status === 'running')
  return running.find((plugin) => plugin.version === version) ?? running[0] ?? ours[0] ?? null
}

export function pickOwnPluginKey(result, options) {
  return pickOwnPlugin(result, options)?.pluginKey ?? null
}

/** Shows one of this plugin's panels in Orca's right sidebar (there is no host API for it). */
export async function openPluginPanel({ cli, pluginKey, panel }) {
  const { code, stdout, stderr } = await runCli(cli, ['plugin', 'open', pluginKey, '--panel', panel], { timeoutMs: 15_000 })
  if (code !== 0) throw new Error((stderr || stdout || `orca plugin open exited ${code}`).trim().split('\n')[0])
}

/** The one-time device token inside an `orca://pair?code=…` link (kept in memory only). */
export function pairingDeviceToken(pairingUrl) {
  try {
    const code = new URL(pairingUrl).searchParams.get('code')
    if (!code) return null
    const offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
    return typeof offer?.deviceToken === 'string' && offer.deviceToken ? offer.deviceToken : null
  } catch {
    return null
  }
}

/** Orca's paired-device registry rows, or [] when it cannot be read right now. */
export async function readDeviceRegistry({ userDataDir = orcaUserDataDir() } = {}) {
  const rows = await readJson(join(userDataDir, 'orca-devices.json'))
  return Array.isArray(rows) ? rows : []
}

/**
 * Finds the registry row behind a pairing code and reports once a phone has signed in with it,
 * so the code can leave the screen immediately. Returns only non-secret fields.
 */
export function pairingRowFor(rows, { deviceToken, deviceId } = {}) {
  const row = rows.find((item) => (deviceId ? item?.deviceId === deviceId : deviceToken && item?.token === deviceToken))
  if (!row || typeof row.deviceId !== 'string') return null
  return { deviceId: row.deviceId, name: typeof row.name === 'string' ? row.name : null, paired: Number(row.lastSeenAt) > 0 }
}
