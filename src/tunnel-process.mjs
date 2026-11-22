import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const QUICK_URL_PATTERN = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i
const CONNECTED_PATTERN = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i
const MAX_RESTARTS = 8

/** Hostname of a quick tunnel announced in a cloudflared log line, if any. */
export function parseQuickTunnelHost(line) {
  const match = QUICK_URL_PATTERN.exec(line)
  return match && !/api\.trycloudflare\.com/i.test(match[1]) ? match[1].toLowerCase() : null
}

export function isConnectedLine(line) {
  return CONNECTED_PATTERN.test(line)
}

/** cloudflared's own message from a JSON or plain log line, for error reporting. */
function logMessage(line) {
  try {
    const parsed = JSON.parse(line)
    return [parsed.message, parsed.error].filter(Boolean).join(': ') || line
  } catch {
    return line.replace(/^\S+\s+(ERR|WRN|INF)\s+/, '')
  }
}

export function buildCloudflaredArgs({ mode, port, configPath }) {
  const common = ['tunnel', '--no-autoupdate', '--config', configPath]
  if (mode === 'named') return [...common, 'run']
  return [...common, '--url', `http://127.0.0.1:${port}`]
}

/**
 * Supervises one cloudflared child. Emits `status` with
 * { state: 'stopped'|'starting'|'connected'|'error', mode, host, port, message }.
 */
export class TunnelProcess extends EventEmitter {
  constructor({ cacheDir, log = () => {}, spawn = nodeSpawn }) {
    super()
    this.cacheDir = cacheDir
    this.log = log
    this.spawn = spawn
    this.child = null
    this.wanted = null
    this.restarts = 0
    this.restartTimer = null
    this.status = { state: 'stopped', mode: null, host: null, port: null, message: null }
  }

  get pidFile() {
    return join(this.cacheDir, 'cloudflared.pid')
  }

  setStatus(patch) {
    // `needsSetup` only describes an error state; anything else clears it.
    const needsSetup = patch.state === undefined ? this.status.needsSetup : patch.state === 'error' && patch.needsSetup === true
    this.status = { ...this.status, ...patch, needsSetup }
    this.emit('status', this.status)
  }

  /** Kills a cloudflared this plugin left behind when its worker was killed without cleanup. */
  killOrphan() {
    let pid
    try {
      pid = Number(readFileSync(this.pidFile, 'utf8').trim())
    } catch {
      return
    }
    rmSync(this.pidFile, { force: true })
    if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
    if (ps.status === 0 && /cloudflared/.test(ps.stdout)) {
      try {
        process.kill(pid, 'SIGTERM')
        this.log(`Stopped an orphaned cloudflared (pid ${pid}).`)
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * @param {{binary: string, mode: 'quick'|'named', port: number, token?: string, host?: string}} options
   */
  start(options) {
    this.stop({ silent: true })
    this.killOrphan()
    this.wanted = options
    this.restarts = 0
    this.launch()
  }

  launch() {
    const options = this.wanted
    if (!options) return
    mkdirSync(this.cacheDir, { recursive: true })
    // An empty config keeps a user's ~/.cloudflared/config.yml from changing this tunnel.
    const configPath = join(this.cacheDir, 'cloudflared-empty.yml')
    writeFileSync(configPath, '{}\n')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    if (options.mode === 'named') env.TUNNEL_TOKEN = options.token
    this.setStatus({
      state: 'starting',
      mode: options.mode,
      port: options.port,
      host: options.mode === 'named' ? options.host : null,
      message: 'Connecting to Cloudflare…'
    })
    const child = this.spawn(options.binary, buildCloudflaredArgs({ ...options, configPath }), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    try {
      writeFileSync(this.pidFile, String(child.pid ?? ''))
    } catch {
      // Best effort: only used for orphan cleanup.
    }
    let lastError = null
    let buffer = ''
    const onData = (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const quickHost = options.mode === 'quick' ? parseQuickTunnelHost(line) : null
        if (quickHost) this.setStatus({ host: quickHost })
        if (isConnectedLine(line) && this.status.host) {
          this.restarts = 0
          this.setStatus({ state: 'connected', message: null })
        }
        if (/\bERR\b|"level":"error"|error=/i.test(line)) lastError = logMessage(line)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      lastError = error.message
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      rmSync(this.pidFile, { force: true })
      if (!this.wanted) return
      const reason = lastError ?? `cloudflared exited (${signal ?? code})`
      this.log(`cloudflared stopped: ${reason}`)
      if (this.restarts >= MAX_RESTARTS) {
        this.setStatus({ state: 'error', message: reason })
        return
      }
      const delay = Math.min(60_000, 2_000 * 2 ** this.restarts)
      this.restarts += 1
      this.setStatus({ state: 'starting', message: `${reason}. Retrying in ${Math.round(delay / 1000)}s…` })
      this.restartTimer = setTimeout(() => this.launch(), delay)
    })
  }

  stop({ silent = false } = {}) {
    this.wanted = null
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 1500).unref?.()
    }
    rmSync(this.pidFile, { force: true })
    if (!silent) this.setStatus({ state: 'stopped', host: this.status.mode === 'named' ? this.status.host : null, message: null })
  }
}
