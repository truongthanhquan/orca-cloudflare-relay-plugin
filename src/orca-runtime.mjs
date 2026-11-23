import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

export const DEFAULT_ORCA_WS_PORT = 6768

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

/** Port of a `ws://host:port` endpoint, or null. */
export function portFromEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    return validPort(Number(url.port || (url.protocol === 'wss:' ? 443 : 80)))
  } catch {
    return null
  }
}

/**
 * The local port of the desktop's mobile/runtime WebSocket server — the same server LAN
 * pairing points phones at. Order: the "Orca port" setting, then Orca's own answer through its
 * CLI (`orca pair --mobile --address 127.0.0.1` reports the local endpoint; without `--rotate`
 * it reuses Orca's unused offer, and its link is dropped here), then Orca's default. The plugin
 * never reads Orca's private files.
 */
export async function findOrcaWebSocketPort({ override, cli, run = runCli } = {}) {
  const explicit = validPort(Number(override))
  if (explicit) return { port: explicit, source: 'setting' }
  if (cli) {
    try {
      const { stdout } = await run(cli, ['pair', '--mobile', '--address', '127.0.0.1', '--json'], { timeoutMs: 20_000 })
      const port = portFromEndpoint(parseCliJson(stdout)?.endpoint)
      if (port) return { port, source: 'orca' }
    } catch {
      // Fall through to Orca's default port.
    }
  }
  return { port: DEFAULT_ORCA_WS_PORT, source: 'default' }
}

/** Candidate locations of the bundled `orca` CLI, most specific first. */
export function orcaCliCandidates({
  platform = process.platform,
  execPath = process.execPath,
  pathEnv = process.env.PATH ?? '',
  // Orca gives workers only an allowlisted environment (no USERPROFILE on Windows): ask the OS.
  home = process.env.HOME || homedir()
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

/**
 * Runs Orca's own updater for this plugin, only when the person clicks Update now. Orca applies
 * its usual checks; an update that asks for more access is refused (approval_required) and must
 * be approved by the person in Orca, never by the plugin.
 */
export async function runPluginUpdate({ cli, pluginKey }) {
  const { code, stdout, stderr } = await runCli(cli, ['plugin', 'update', pluginKey, '--json'], { timeoutMs: 180_000 })
  let payload = null
  try {
    payload = JSON.parse(stdout.slice(stdout.indexOf('{')))
  } catch {
    // Non-JSON failure output.
  }
  const result = payload?.result ?? payload
  if (code === 3 || payload?.error?.code === 'approval_required' || payload?.error?.code === 'approval_stale') {
    const growth = payload?.error?.data?.update?.growth
    const added = [...(growth?.capabilities ?? []).map((kind) => `access "${kind}"`), ...(growth?.contributions ?? [])]
    return { status: 'approval_required', added: added.slice(0, 8) }
  }
  if (code !== 0 || payload?.ok === false) {
    throw new Error(payload?.error?.message?.split('\n')[0] ?? (stderr || stdout || `orca plugin update exited ${code}`).trim().split('\n')[0])
  }
  return { status: result?.status ?? 'updated', version: result?.version ?? null }
}

/** Shows one of this plugin's panels in Orca's right sidebar (there is no host API for it). */
export async function openPluginPanel({ cli, pluginKey, panel }) {
  const { code, stdout, stderr } = await runCli(cli, ['plugin', 'open', pluginKey, '--panel', panel], { timeoutMs: 15_000 })
  if (code !== 0) throw new Error((stderr || stdout || `orca plugin open exited ${code}`).trim().split('\n')[0])
}
