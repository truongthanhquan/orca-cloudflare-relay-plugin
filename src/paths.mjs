import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Orca's Electron `userData` directory. The plugin worker only receives an allowlisted
 * environment (no APPDATA / XDG_CONFIG_HOME), so derive it from the home directory.
 */
export function orcaUserDataDir(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') return join(home, 'AppData', 'Roaming', 'orca')
  return join(home, '.config', 'orca')
}

/** Where this plugin keeps its managed cloudflared binary and pid file. */
export function pluginCacheDir(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'orca-cloudflare-relay')
  if (platform === 'win32') return join(home, 'AppData', 'Local', 'orca-cloudflare-relay')
  return join(home, '.cache', 'orca-cloudflare-relay')
}
