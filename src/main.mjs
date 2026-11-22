import { generateCloudflareConfig } from './cloudflare-config.mjs'
import { discoverCloudflare } from './cloudflare-api.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const settingKeys = [
  'relayDomain',
  'authIssuer',
  'jwksUrl'
]

export default function activate(orca) {
  async function readSettings() {
    return orca.settings.get()
  }

  orca.commands.register('cloudflare-relay.validate', async () => {
    const settings = await readSettings()
    try {
      generateCloudflareConfig(settings)
      return 'Cloudflare Relay settings are valid.'
    } catch (error) {
      return `Invalid settings: ${error instanceof Error ? error.message : String(error)}`
    }
  })

  orca.commands.register('cloudflare-relay.generate', async () => {
    const settings = await readSettings()
    try {
      const config = generateCloudflareConfig(settings)
      await orca.host.call('storage.set', { key: 'last-wrangler-config', value: config })
      return 'Generated .wrangler-deploy-cloudflare.jsonc. Open the Cloudflare Relay settings panel to download it.'
    } catch (error) {
      return `Invalid settings: ${error instanceof Error ? error.message : String(error)}`
    }
  })

  orca.panels?.handle?.('generate-config', async () => {
    const settings = await readSettings()
    try {
      const config = generateCloudflareConfig(settings)
      await orca.host.call('storage.set', { key: 'last-wrangler-config', value: config })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  orca.panels?.handle?.('save-secrets', async (input) => {
    if (typeof input?.apiToken !== 'string') {
      return { ok: false, error: 'Cloudflare API token is required.' }
    }
    await orca.host.call('secrets.set', { key: 'cloudflareApiToken', value: input.apiToken })
    return { ok: true }
  })

  orca.panels?.handle?.('auto-setup', async (input) => {
    try {
      const apiToken = await orca.host.call('secrets.get', { key: 'cloudflareApiToken' })
      const token = apiToken?.value
      if (typeof token !== 'string') {
        return { ok: false, error: 'Save the Cloudflare API token first.' }
      }
      const accounts = await discoverCloudflare(token)
      const accountId = accounts[0].id
      const relayDomain = String(input?.relayDomain ?? '').trim()
      if (!relayDomain) {
        return { ok: false, error: 'The relay hostname is required.' }
      }
      const zone = await import('./cloudflare-api.mjs').then(({ findZone }) =>
        findZone(token, accountId, relayDomain)
      )
      const settings = await readSettings()
      const config = generateCloudflareConfig({
        accountId,
        workerName: 'orca-relay-edge',
        domain: relayDomain,
        jwksUrl: settings.jwksUrl,
        authIssuer: settings.authIssuer,
        audience: 'orca-relay',
        adminIssuer: settings.authIssuer
      })
      await orca.host.call('storage.set', { key: 'last-wrangler-config', value: config })
      await orca.host.call('storage.set', {
        key: 'cloudflare-discovery',
        value: { accountId, accountName: accounts[0].name, zoneId: zone.id }
      })
      const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'auto-deploy.mjs')
      const deployed = await new Promise((resolveDone, rejectDone) => {
        const child = spawn(
          process.execPath,
          [
            script,
            '--apiToken',
            token,
            '--accountId',
            accountId,
            '--relayDomain',
            relayDomain,
            '--jwksUrl',
            String(settings.jwksUrl),
            '--authIssuer',
            String(settings.authIssuer)
          ],
          { env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.on('error', rejectDone)
        child.on('close', (code) => {
          if (code === 0) {
            try {
              resolveDone(JSON.parse(stdout.trim().split('\n').at(-1)))
            } catch {
              resolveDone({ ok: true, deployed: true })
            }
          } else {
            rejectDone(new Error(stderr || stdout || `Deployment exited ${code}`))
          }
        })
      })
      return {
        ok: true,
        accountId,
        accountName: accounts[0].name,
        zoneId: zone.id,
        deployed: deployed.deployed === true,
        relayUrl: deployed.relayUrl ?? `https://${relayDomain}`
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  orca.panels?.handle?.('download-config', async () => {
    const stored = await orca.host.call('storage.get', { key: 'last-wrangler-config' })
    if (typeof stored?.value !== 'string') {
      return { ok: false, error: 'Generate the configuration first.' }
    }
    return { ok: true, content: stored.value }
  })

  orca.log(`Loaded Cloudflare Relay Setup; settings: ${settingKeys.join(', ')}`)
}
