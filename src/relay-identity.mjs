import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { relayStateDir } from './paths.mjs'

/**
 * A paired phone dials `<worker>/v1/c/<hostId>`, so that address must never change behind its
 * back. Orca keeps this plugin's storage per plugin key, which a reinstall, a catalog install
 * after a Git install, or a development copy does not share. This file remembers the host id per
 * relay Worker for the whole machine, so every copy and every redeploy keeps the same address.
 *
 * Only the Worker URL and host id are stored. Neither is secret: the host id is already inside
 * every pairing code. The host key and admin/owner tokens stay in Orca's encrypted secrets.
 */
const FILE = 'relay-identity.json'
const HOST_ID = /^[A-Za-z0-9_-]{16,64}$/

function originOf(workerUrl) {
  try {
    return new URL(workerUrl).origin.toLowerCase()
  } catch {
    return null
  }
}

async function readAll(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8'))
    return parsed && typeof parsed.relays === 'object' && parsed.relays ? parsed : { relays: {} }
  } catch {
    return { relays: {} }
  }
}

/** The host id this machine registered on that relay Worker before, or null. */
export async function rememberedHostId(workerUrl, { dir = relayStateDir() } = {}) {
  const origin = originOf(workerUrl)
  if (!origin) return null
  const hostId = (await readAll(dir)).relays[origin]?.hostId
  return typeof hostId === 'string' && HOST_ID.test(hostId) ? hostId : null
}

/** Records the host id registered on a relay Worker (atomic write, owner-only file). */
export async function rememberHostId(workerUrl, hostId, { dir = relayStateDir(), ifAbsent = false } = {}) {
  const origin = originOf(workerUrl)
  if (!origin || !HOST_ID.test(String(hostId))) return
  const all = await readAll(dir)
  if (all.relays[origin]?.hostId === hostId || (ifAbsent && all.relays[origin])) return
  all.relays[origin] = { hostId, updatedAt: new Date().toISOString() }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `${FILE}.${process.pid}.tmp`)
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, join(dir, FILE))
}
