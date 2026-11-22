import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Pinned cloudflared release; digests are the SHA-256 values GitHub publishes for each asset. */
export const CLOUDFLARED_VERSION = '2026.11.1'

export const CLOUDFLARED_ASSETS = {
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f' },
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a' },
  'linux-arm': { file: 'cloudflared-linux-arm', sha256: '0196274a8237660991a27211d7423d1c2fdcb6be56fcae473dd330479d4692fb' },
  'linux-ia32': { file: 'cloudflared-linux-386', sha256: '757c510745a9884f39e1a99d19c1e18bd5e0012b3368455a958471c71d875530' },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35' },
  'win32-ia32': { file: 'cloudflared-windows-386.exe', sha256: '060868e138e638237e33329315c3e374e0156a2fb18879e571dbc0d506060df3' }
}

export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}`]
  if (!asset) throw new Error(`cloudflared has no build for ${platform}/${arch}. Set "cloudflared path" manually.`)
  return {
    ...asset,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`,
    binaryName: platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  }
}

function run(command, args) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', rejectDone)
    child.on('close', (code) =>
      code === 0 ? resolveDone() : rejectDone(new Error(stderr.trim() || `${command} exited ${code}`))
    )
  })
}

/**
 * Returns a usable cloudflared executable: the user's override, or a verified copy of the
 * pinned release kept in the plugin cache (downloaded once on first use).
 */
export async function ensureCloudflared({ cacheDir, override, onProgress = () => {}, fetchImpl = fetch } = {}) {
  if (override) {
    if (!existsSync(override)) throw new Error(`cloudflared not found at ${override}`)
    return override
  }
  const asset = cloudflaredAsset()
  const dir = join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
  const binary = join(dir, asset.binaryName)
  if (existsSync(binary)) return binary

  onProgress(`Downloading cloudflared ${CLOUDFLARED_VERSION}…`)
  const response = await fetchImpl(asset.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Could not download cloudflared (HTTP ${response.status}).`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error('The downloaded cloudflared does not match its published checksum; refusing to run it.')
  }

  await mkdir(dir, { recursive: true })
  const staging = join(dir, `.download-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  try {
    if (asset.file.endsWith('.tgz')) {
      await mkdir(staging, { recursive: true })
      const archive = join(staging, asset.file)
      await writeFile(archive, bytes)
      await run('tar', ['-xzf', archive, '-C', staging])
      await chmod(join(staging, 'cloudflared'), 0o755)
      await rename(join(staging, 'cloudflared'), binary)
    } else {
      await writeFile(staging, bytes, { mode: 0o755 })
      await rename(staging, binary)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return binary
}
