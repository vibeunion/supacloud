import { afterEach, describe, expect, test } from 'bun:test'
import { createBackend } from '../src/runtime/index.js'
import { testTimeout } from './helpers/timeouts.js'

type Message = Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function backendForTest() {
  const backend = await createBackend({ startRuntimeServices: false, log: () => {} })
  cleanups.push(() => backend.close())
  return backend
}

function peer(backend: Awaited<ReturnType<typeof createBackend>>, topic: string) {
  const messages: Message[] = []
  let notify: (() => void) | undefined
  const connection = backend.realtime.connect({
    send: (text) => {
      messages.push(JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text)) as Message)
      notify?.()
    },
    close: () => {},
  })
  cleanups.push(() => connection.onClose())
  const waitFor = async (predicate: (message: Message) => boolean) => {
    if (messages.some(predicate)) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        notify = undefined
        reject(new Error('realtime message timeout'))
      }, 2_000)
      notify = () => {
        if (!messages.some(predicate)) return
        clearTimeout(timeout)
        notify = undefined
        resolve()
      }
    })
  }
  const join = async (accessToken?: string, config: Record<string, unknown> = {}) => {
    connection.onMessage(JSON.stringify({
      topic: `realtime:${topic}`,
      event: 'phx_join',
      ref: 'join',
      payload: { ...(accessToken ? { access_token: accessToken } : {}), config },
    }))
    await waitFor((message) => message.event === 'phx_reply')
  }
  return { messages, join, waitFor }
}

function apiHeaders(backend: Awaited<ReturnType<typeof createBackend>>, token = backend.anonKey) {
  return { apikey: backend.anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

describe('Realtime HTTP broadcast', () => {
  test('delivers a public broadcast with the documented messages envelope', async () => {
    const backend = await backendForTest()
    const subscriber = peer(backend, 'http-public')
    await subscriber.join()

    const response = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: apiHeaders(backend),
      body: JSON.stringify({
        messages: [{ topic: 'http-public', event: 'notice', payload: { ok: true } }],
      }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ message: 'Broadcast sent' })
    await subscriber.waitFor((message) => message.event === 'broadcast')
    expect(subscriber.messages.find((message) => message.event === 'broadcast')).toMatchObject({
      topic: 'realtime:http-public',
      payload: { type: 'broadcast', event: 'notice', payload: { ok: true } },
    })
  }, testTimeout(30_000))

  test('requires INSERT authorization for private topics and delivers only after every message is authorized', async () => {
    const backend = await backendForTest()
    await backend.db.exec(`
      create policy http_private_read on realtime.messages
        for select to authenticated using (realtime.topic() = 'http-private');
      create policy http_private_write on realtime.messages
        for insert to authenticated with check (realtime.topic() = 'http-private');
    `)
    const signup = await backend.fetch('http://local/auth/v1/signup', {
      method: 'POST',
      headers: apiHeaders(backend),
      body: JSON.stringify({ email: 'http-broadcast@example.test', password: 'correct-horse-battery-staple' }),
    })
    expect(signup.status).toBe(200)
    const session = await signup.json() as { access_token: string }

    const subscriber = peer(backend, 'http-private')
    await subscriber.join(session.access_token, { private: true })
    expect(subscriber.messages.some((message) => message.event === 'phx_reply' && record(message.payload)['status'] === 'ok')).toBe(true)

    const denied = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: apiHeaders(backend),
      body: JSON.stringify({ messages: [{ topic: 'http-private', event: 'secret', private: true, payload: {} }] }),
    })
    expect(denied.status).toBe(403)

    const accepted = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: apiHeaders(backend, session.access_token),
      body: JSON.stringify({
        messages: [
          { topic: 'http-private', event: 'first', private: true, payload: { n: 1 } },
          { topic: 'http-private', event: 'second', private: true, payload: { n: 2 } },
        ],
      }),
    })
    expect(accepted.status).toBe(202)
    await subscriber.waitFor((message) => message.event === 'broadcast' && record(message.payload)['event'] === 'second')
    expect(subscriber.messages.filter((message) => message.event === 'broadcast').map((message) => record(message.payload)['event']))
      .toEqual(['first', 'second'])
  }, testTimeout(30_000))

  test('rejects malformed envelopes, missing API keys, and oversized batches', async () => {
    const backend = await backendForTest()
    const invalid = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: apiHeaders(backend),
      body: JSON.stringify({ messages: [{ topic: '', event: 'notice' }] }),
    })
    expect(invalid.status).toBe(400)

    const unauthorized = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: 'http-public', event: 'notice' }] }),
    })
    expect(unauthorized.status).toBe(401)

    const tooMany = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: apiHeaders(backend),
      body: JSON.stringify({
        messages: Array.from({ length: 101 }, () => ({ topic: 'http-public', event: 'notice' })),
      }),
    })
    expect(tooMany.status).toBe(400)

    const get = await backend.fetch('http://local/realtime/v1/api/broadcast', {
      method: 'GET',
      headers: apiHeaders(backend),
    })
    expect(get.status).toBe(405)
  }, testTimeout(30_000))
})
