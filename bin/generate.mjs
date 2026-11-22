import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateCloudflareConfig } from '../src/cloudflare-config.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!key?.startsWith('--')) throw new Error(`Invalid argument: ${key ?? ''}`)
  args.set(key.slice(2), process.argv[i + 1])
}

const input = Object.fromEntries(
  [
    'accountId',
    'workerName',
    'domain',
    'edgeDomain',
    'hyperdriveId',
    'jwksUrl',
    'authIssuer',
    'audience',
    'adminIssuer'
  ].map((key) => [key, args.get(key)])
)

const config = generateCloudflareConfig(input)
const target = resolve(process.cwd(), '.wrangler-deploy-cloudflare.jsonc')
await writeFile(target, config, { encoding: 'utf8', mode: 0o600 })
console.log(`Wrote ${target}`)
