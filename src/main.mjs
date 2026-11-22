import { generateCloudflareConfig } from './cloudflare-config.mjs'

const settingKeys = [
  'accountId',
  'workerName',
  'domain',
  'edgeDomain',
  'hyperdriveId',
  'jwksUrl',
  'authIssuer',
  'audience',
  'adminIssuer'
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

  orca.panels?.handle?.('download-config', async () => {
    const stored = await orca.host.call('storage.get', { key: 'last-wrangler-config' })
    if (typeof stored?.value !== 'string') {
      return { ok: false, error: 'Generate the configuration first.' }
    }
    return { ok: true, content: stored.value }
  })

  orca.log(`Loaded Cloudflare Relay Setup; settings: ${settingKeys.join(', ')}`)
}
