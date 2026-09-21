import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createBackend, type SupaCloudLiteBackend } from '../src/runtime/index.js'
import { matchFilter } from '../src/runtime/realtime/engine.js'

let backend: SupaCloudLiteBackend
beforeAll(async () => {
  backend = await createBackend({ startRuntimeServices: false, log: () => {} })
})
afterAll(async () => { await backend?.close() })

async function joinedSession() {
  const messages: Array<string | Uint8Array> = []
  const session = backend.realtime.connect({ send: (message) => { messages.push(message) }, close: () => {} })
  session.onMessage(JSON.stringify({
    topic: 'realtime:boundary',
    event: 'phx_join',
    ref: 'join',
    payload: { config: { broadcast: { self: true, ack: true } } },
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(messages.some((message) => typeof message === 'string' && message.includes('"status":"ok"'))).toBe(true)
  messages.length = 0
  return { session, messages }
}

function binaryMessage(encoding = 1): Uint8Array {
  const fields = ['', 'ref', 'realtime:boundary', 'changed', '']
  const values = fields.map((field) => new TextEncoder().encode(field))
  return new Uint8Array([
    3, ...values.map((value) => value.length), encoding,
    ...values.flatMap((value) => [...value]), ...new TextEncoder().encode('{"ok":true}'),
  ])
}

test('truncated binary fields and unknown encodings never broadcast or acknowledge', async () => {
  const { session, messages } = await joinedSession()
  try {
    const complete = binaryMessage()
    for (let length = 0; length < complete.length - '{"ok":true}'.length; length++) {
      session.onMessage(complete.subarray(0, length))
    }
    session.onMessage(binaryMessage(2))
    session.onMessage(complete.subarray(0, complete.length - 1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages).toEqual([])
  } finally {
    session.onClose()
  }
})

test('invalid JSON message shapes are dropped without an unhandled rejection', async () => {
  const { session, messages } = await joinedSession()
  try {
    for (const message of [
      null, false, 1, 'text', [], [null, null, 'phoenix', 'heartbeat'],
      { topic: 'phoenix', event: 'heartbeat', payload: null },
      { topic: {}, event: 'broadcast', payload: {} },
      { topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 1 },
    ]) {
      session.onMessage(JSON.stringify(message))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages).toEqual([])
    session.onMessage(JSON.stringify([null, 'heart', 'phoenix', 'heartbeat', {}]))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages).toHaveLength(1)
  } finally {
    session.onClose()
  }
})

test.each([
  { config: null },
  { config: { private: 'false' } },
  { config: { broadcast: { self: 'true' } } },
  { config: { presence: { enabled: 1 } } },
  { config: { postgres_changes: {} } },
  { config: { postgres_changes: [null] } },
  { config: { postgres_changes: [{ event: 1 }] } },
  { config: { postgres_changes: [{ filter: false }] } },
  { access_token: {} },
])('invalid join payload never creates a channel: %j', async (payload) => {
  const messages: Array<string | Uint8Array> = []
  const session = backend.realtime.connect({ send: (message) => { messages.push(message) }, close: () => {} })
  try {
    session.onMessage(JSON.stringify({ topic: 'realtime:bad', event: 'phx_join', ref: 'bad', payload }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages.filter((message) => typeof message === 'string').map((message) => JSON.parse(message)))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ status: 'error' }) })])
    messages.length = 0
    session.onMessage(JSON.stringify({
      topic: 'realtime:bad', event: 'broadcast', ref: 'broadcast',
      payload: { event: 'changed', payload: { ok: true } },
    }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages).toEqual([])
  } finally {
    session.onClose()
  }
})

test('valid binary JSON broadcasts retain payload and acknowledgement', async () => {
  const { session, messages } = await joinedSession()
  try {
    const frame = binaryMessage()
    const padded = new Uint8Array(frame.length + 8)
    padded.set(frame, 4)
    session.onMessage(padded.subarray(4, 4 + frame.length))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(messages.filter((message) => typeof message === 'string').map((message) => JSON.parse(message))).toEqual([
      { topic: 'realtime:boundary', event: 'broadcast', payload: { type: 'broadcast', event: 'changed', payload: { ok: true } }, ref: null },
      { topic: 'realtime:boundary', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: 'ref', join_ref: null },
    ])
  } finally {
    session.onClose()
  }
})

test('malformed filter syntax is rejected while recognized filters match', () => {
  expect(matchFilter('id=unsupported.1', { id: 1 })).toBe(false)
  expect(matchFilter('=eq.1', { id: 1 })).toBe(false)
  expect(matchFilter('id=eq.1', { id: 1 })).toBe(true)
  expect(matchFilter('id=in.(1,2)', { id: 2 })).toBe(true)
})
