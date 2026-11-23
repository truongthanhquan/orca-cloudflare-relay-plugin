import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
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

test('never reads Orca\'s private files or decodes pairing codes', () => {
  const files = ['panel.html', ...readdirSync('src').filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`)]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /orca-devices|orca-runtime\.json|mobile-ws-fallback|Application Support', 'orca'|deviceToken/, file)
  }
})

test('registration explains a Deploy-button Worker that belongs to another desktop', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'owned_by_another_desktop' }), { status: 403 })
  await assert.rejects(
    registerRelayHost({ workerUrl: 'https://r.example.workers.dev', hostId: 'h'.repeat(22), hostKey: 'k'.repeat(43), adminToken: 'o'.repeat(43), fetchImpl }),
    /already belongs to another Orca desktop/
  )
})

test('the panel names the cloudflared version the plugin downloads, before it is downloaded', async () => {
  const { CLOUDFLARED_VERSION } = await import('../src/cloudflared-binary.mjs')
  const panel = readFileSync('panel.html', 'utf8')
  const notes = panel.match(/class="muted hint download-note">[^\n]*/g) ?? []
  assert.equal(notes.length, 2, 'one note for each tunnel mode')
  for (const note of notes) assert.ok(note.includes(CLOUDFLARED_VERSION), note)
})
