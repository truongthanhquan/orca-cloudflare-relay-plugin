import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCloudflareConfig } from '../src/cloudflare-config.mjs'

const valid = {
  accountId: '0123456789abcdef0123456789abcdef',
  workerName: 'orca-relay-edge',
  domain: 'relay.example.com',
  jwksUrl: 'https://login.example.com/.well-known/jwks.json',
  authIssuer: 'https://login.example.com',
  audience: 'orca-relay',
  adminIssuer: 'https://director.example.com'
}

test('generates one Cloudflare relay origin with object storage', () => {
  const config = JSON.parse(generateCloudflareConfig(valid))
  assert.equal(config.vars.EDGE_BACKEND, 'object')
  assert.deepEqual(config.routes.map((route) => route.pattern), ['relay.example.com'])
  assert.equal(config.hyperdrive, undefined)
})
