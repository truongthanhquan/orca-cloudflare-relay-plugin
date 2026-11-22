import { generateCloudflareConfig } from './cloudflare-config.mjs'
import { discoverCloudflare, ensureHyperdrive } from './cloudflare-api.mjs'

const settingKeys = [
  'relayDomain',
  'edgeDomain',
  'authIssuer',
  'jwksUrl',
  'postgresUrl'
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
    if (typeof input?.apiToken !== 'string' || typeof input?.postgresUrl !== 'string') {
      return { ok: false, error: 'Cloudflare API token and Postgres URL are required.' }
    }
    await orca.host.call('secrets.set', { key: 'cloudflareApiToken', value: input.apiToken })
    await orca.host.call('secrets.set', { key: 'postgresUrl', value: input.postgresUrl })
    return { ok: true }
  })

  orca.panels?.handle?.('auto-setup', async (input) => {
    try {
      const apiToken = await orca.host.call('secrets.get', { key: 'cloudflareApiToken' })
      const postgresSecret = await orca.host.call('secrets.get', { key: 'postgresUrl' })
      const token = apiToken?.value
      const postgresUrl = postgresSecret?.value
      if (typeof token !== 'string' || typeof postgresUrl !== 'string') {
        return { ok: false, error: 'Save the Cloudflare API token and Postgres URL first.' }
      }
      const accounts = await discoverCloudflare(token)
      const accountId = accounts[0].id
      const relayDomain = String(input?.relayDomain ?? '').trim()
      const edgeDomain = String(input?.edgeDomain ?? '').trim()
      if (!relayDomain || !edgeDomain) {
        return { ok: false, error: 'Relay and edge hostnames are required.' }
      }
      const zone = await import('./cloudflare-api.mjs').then(({ findZone }) =>
        findZone(token, accountId, relayDomain)
      )
      const hyperdrive = await ensureHyperdrive(token, accountId, postgresUrl)
      const settings = await readSettings()
      const config = generateCloudflareConfig({
        accountId,
        workerName: 'orca-relay-edge',
        domain: relayDomain,
        edgeDomain,
        hyperdriveId: hyperdrive.id,
        jwksUrl: settings.jwksUrl,
        authIssuer: settings.authIssuer,
        audience: 'orca-relay',
        adminIssuer: settings.authIssuer
      })
      await orca.host.call('storage.set', { key: 'last-wrangler-config', value: config })
      await orca.host.call('storage.set', {
        key: 'cloudflare-discovery',
        value: { accountId, accountName: accounts[0].name, zoneId: zone.id, hyperdriveId: hyperdrive.id }
      })
      return {
        ok: true,
        accountId,
        accountName: accounts[0].name,
        hyperdriveId: hyperdrive.id,
        zoneId: zone.id
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
