import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { pairingDeviceToken, pairingRowFor } from '../src/orca-runtime.mjs'
import { registerRelayHost } from '../src/worker-deploy.mjs'
import { splice } from '../src/worker-relay-bridge.mjs'

/** Minimal WebSocket stand-in: addEventListener/send/close and a settable readyState. */
class FakeSocket extends EventEmitter {
  constructor(readyState = 1) {
    super()
    this.readyState = readyState
    this.sent = []
    this.closedWith = null
  }
  addEventListener(name, fn) {
    this.on(name, fn)
  }
  send(data) {
    this.sent.push(data)
  }
  close(code, reason) {
    this.closedWith = { code, reason }
    this.readyState = 3
  }
}

test('splice drops a peer that floods before the other side has connected', () => {
  const phone = new FakeSocket(1)
  const local = new FakeSocket(0)
  splice(phone, local, { maxQueuedBytes: 100 })
  phone.emit('message', { data: 'x'.repeat(60) })
  assert.equal(phone.closedWith, null)
  phone.emit('message', { data: 'x'.repeat(60) })
  assert.equal(phone.closedWith?.code, 4009)
  assert.equal(local.closedWith?.code, 4009)
})

test('splice delivers queued frames in order once the other side opens', () => {
  const phone = new FakeSocket(1)
  const local = new FakeSocket(0)
  splice(phone, local, { initial: ['hello'] })
  phone.emit('message', { data: 'a' })
  local.readyState = 1
  local.emit('open')
  phone.emit('message', { data: 'b' })
  assert.deepEqual(local.sent, ['hello', 'a', 'b'])
})

const fakePairingUrl = (offer) => `orca://pair?code=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`

test('reads the one-time device token from a pairing link', () => {
  assert.equal(pairingDeviceToken(fakePairingUrl({ v: 2, endpoint: 'wss://x', deviceToken: 'tok' })), 'tok')
  assert.equal(pairingDeviceToken('orca://pair?code=not-json'), null)
  assert.equal(pairingDeviceToken('nonsense'), null)
})

test('notices when a phone has signed in with the shown code (without exposing the token)', () => {
  const rows = [
    { deviceId: 'old', token: 'other', name: 'Old phone', lastSeenAt: 5 },
    { deviceId: 'new', token: 'tok', name: 'Mobile', lastSeenAt: 0 }
  ]
  assert.deepEqual(pairingRowFor(rows, { deviceToken: 'tok' }), { deviceId: 'new', name: 'Mobile', paired: false })
  // After the ticket exchange the token changes, so later checks go by device id.
  rows[1] = { deviceId: 'new', token: 'replaced', name: 'Mobile', lastSeenAt: 99 }
  assert.deepEqual(pairingRowFor(rows, { deviceId: 'new' }), { deviceId: 'new', name: 'Mobile', paired: true })
  assert.equal(pairingRowFor(rows, { deviceToken: undefined }), null)
})

test('registration explains a Deploy-button Worker that belongs to another desktop', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'owned_by_another_desktop' }), { status: 403 })
  await assert.rejects(
    registerRelayHost({ workerUrl: 'https://r.example.workers.dev', hostId: 'h'.repeat(22), hostKey: 'k'.repeat(43), adminToken: 'o'.repeat(43), fetchImpl }),
    /already belongs to another Orca desktop/
  )
})
