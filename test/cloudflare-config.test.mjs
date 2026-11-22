import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCloudflareConfig } from '../src/cloudflare-config.mjs'

const valid = {
  accountId: '0123456789abcdef0123456789abcdef',
  workerName: 'orca-relay-edge',
  domain: 'relay.example.com',
  edgeDomain: 'edge.relay.example.com',
  hyperdriveId: 'abcdef0123456789abcdef0123456789',
  jwksUrl: 'https://login.example.com/.well-known/jwks.json',
  authIssuer: 'https://login.example.com',
  audience: 'orca-relay',
  adminIssuer: 'https://director.example.com'
}

test('generates director and separate edge routes', () => {
  const config = JSON.parse(generateCloudflareConfig(valid))
  assert.equal(config.vars.DIRECTOR_HOSTNAME, 'relay.example.com')
  assert.equal(config.vars.DIRECTOR_EDGE_URL, 'https://edge.relay.example.com')
  assert.deepEqual(
    config.routes.map((route) => route.pattern),
    ['relay.example.com', 'edge.relay.example.com']
  )
})

test('rejects equal director and edge hostnames', () => {
  assert.throws(
    () => generateCloudflareConfig({ ...valid, edgeDomain: valid.domain }),
    /must be different/
  )
})
