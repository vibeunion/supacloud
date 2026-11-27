import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DbEngine } from '../src/runtime/db/engine.js'
import { createBackend, type SupaCloudLiteBackend } from '../src/runtime/index.js'
import { createTemporaryNativeEngine } from '../src/runtime/node/db-diff.js'
import { isNativeEngineSupported } from '../src/runtime/node/native/engine.js'
import { openRealtimeCore, type OpenedRealtimeCore } from '../src/runtime/realtime/core-asset.js'
import { realtimeCoreLibraryName } from '../src/runtime/realtime/core-ffi.js'
import type { RealtimeProtocolCore, RealtimeSocketLike } from '../src/runtime/realtime/engine.js'

/**
 * Real-database Realtime lifecycle regression for the Rust core.
 *
 * PGlite always runs; set SUPACLOUD_LITE_TEST_NATIVE=1 to replay the same
 * scenarios against the embedded native PostgreSQL engine. Unlike the parity
 * vectors, these tests exercise the real CDC trigger/LISTEN pipeline, real
 * realtime.messages RLS policies, and the Bun socket lifecycle around
 * disconnects and reconnects.
 */

const packageDir = resolve(import.meta.dir, '..')
const libraryName = realtimeCoreLibraryName()
const libraryPath = [
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'debug', libraryName),
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'release', libraryName),
  join(packageDir, 'dist', 'native', libraryName),
].find((candidate) => existsSync(candidate))

const nativeEnabled = process.env.SUPACLOUD_LITE_TEST_NATIVE === '1' && isNativeEngineSupported()
const engineLabel = nativeEnabled ? 'native PostgreSQL' : 'PGlite'
const describeCore = libraryPath ? describe : describe.skip
const testTimeout = 120_000

const MIGRATION = `
create table public.rt_items (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false
);
grant select on public.rt_items to anon, authenticated, service_role;
`

interface WireMessage {
  topic: string
  event: string
  payload: Record<string, any>
  ref: string | null
  join_ref?: string | null
}

interface Waiter {
  test: (message: WireMessage) => boolean
  resolve: (message: WireMessage) => void
  reject: (error: Error) => void
  label: string
  timer: ReturnType<typeof setTimeout>
}

class ClientSocket implements RealtimeSocketLike {
  readonly messages: WireMessage[] = []
  closed = false
  private readonly waiters: Waiter[] = []

  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') return
    const parsed = JSON.parse(data) as WireMessage | [string | null, string | null, string, string, Record<string, any>]
    const message: WireMessage = Array.isArray(parsed)
      ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2]!, event: parsed[3]!, payload: parsed[4] ?? {} }
      : parsed
    this.messages.push(message)
    for (const waiter of [...this.waiters]) {
      if (!waiter.test(message)) continue
      clearTimeout(waiter.timer)
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve(message)
    }
  }

  close(): void {
    this.closed = true
  }

  waitFor(
    label: string,
    test: (message: WireMessage) => boolean,
    { after = 0, timeoutMs = 15_000 }: { after?: number; timeoutMs?: number } = {}
  ): Promise<WireMessage> {
    const received = this.messages.slice(after).find(test)
    if (received) return Promise.resolve(received)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        test,
        resolve,
        reject,
        label,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error(`timed out waiting for ${label}; received ${this.messages.map((m) => `${m.event}:${m.ref}`).join(', ')}`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  replyTo(ref: string): Promise<WireMessage> {
    return this.waitFor(`phx_reply ${ref}`, (m) => m.event === 'phx_reply' && m.ref === ref)
  }

  event(event: string, after = 0, test?: (message: WireMessage) => boolean): Promise<WireMessage> {
    return this.waitFor(event, (m) => m.event === event && (test?.(m) ?? true), { after })
  }
}

interface Client {
  socket: ClientSocket
  send(message: unknown): void
  close(): void
}

function openClient(backend: SupaCloudLiteBackend, vsn = '1.0.0'): Client {
  const socket = new ClientSocket()
  const handlers = backend.realtime.connect(socket, { vsn })
  return {
    socket,
    send: (message) => handlers.onMessage(JSON.stringify(message)),
    close: () => handlers.onClose(),
  }
}

const joinChannel = (topic: string, ref: string, config: Record<string, unknown>) => ({
  topic,
  event: 'phx_join',
  ref,
  payload: { config },
})
const track = (topic: string, ref: string, payload: Record<string, unknown>) => ({
  topic,
  event: 'presence',
  ref,
  payload: { event: 'track', payload },
})
const sendBroadcast = (topic: string, ref: string, event: string, payload: unknown) => ({
  topic,
  event: 'broadcast',
  ref,
  payload: { type: 'broadcast', event, payload },
})

describeCore(`Realtime core lifecycle on ${engineLabel}`, () => {
  let opened: OpenedRealtimeCore
  const backends: SupaCloudLiteBackend[] = []
  const engines: DbEngine[] = []

  beforeAll(async () => {
    opened = await openRealtimeCore({ path: libraryPath, ignoreEmbedded: true, env: {} })
  })

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close().catch(() => {})
    for (const engine of engines.splice(0)) await engine.close().catch(() => {})
  })

  afterAll(async () => {
    await opened?.close()
  })

  async function startBackend(): Promise<SupaCloudLiteBackend> {
    let engine: DbEngine | undefined
    if (nativeEnabled) {
      engine = await createTemporaryNativeEngine()
      engines.push(engine)
    }
    // createBackend owns the core it is handed; share one loaded library across
    // tests by handing it a wrapper without a close hook.
    const core: RealtimeProtocolCore = { call: opened.core.call.bind(opened.core) }
    const backend = await createBackend({
      ...(engine ? { engine } : {}),
      realtimeCore: core,
      startRuntimeServices: true,
      log: () => {},
      migrations: [{ name: '20260815000000_realtime_core_lifecycle', sql: MIGRATION }],
    })
    backends.push(backend)
    return backend
  }

  test(
    'keeps a long-lived channel alive through heartbeats and delivers CDC',
    async () => {
      const backend = await startBackend()
      const client = openClient(backend)
      client.send(
        joinChannel('realtime:items', 'join', {
          broadcast: { self: true, ack: true },
          postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'rt_items' }],
        })
      )
      const reply = await client.socket.replyTo('join')
      expect(reply.payload['status']).toBe('ok')
      const bindings = reply.payload['response']['postgres_changes'] as { id: number }[]
      expect(bindings).toHaveLength(1)
      await client.socket.event('system')

      for (let index = 0; index < 30; index += 1) {
        const ref = `hb-${index}`
        client.send({ topic: 'phoenix', event: 'heartbeat', ref, payload: {} })
        const beat = await client.socket.replyTo(ref)
        expect(beat.payload['status']).toBe('ok')
        if (index % 5 === 4) await Bun.sleep(5)
      }

      await backend.db.engine.exec(`insert into public.rt_items (title, done) values ('long-lived', false)`)
      const change = await client.socket.event('postgres_changes')
      expect(change.payload['ids']).toEqual([bindings[0]!.id])
      expect(change.payload['data']['record']['title']).toBe('long-lived')
      expect(change.payload['data']['columns'].map((column: { name: string }) => column.name)).toEqual(['id', 'title', 'done'])

      client.send(sendBroadcast('realtime:items', 'after-cdc', 'ping', { n: 1 }))
      const echo = await client.socket.event('broadcast')
      expect(echo.payload['payload']).toEqual({ n: 1 })
      expect((await client.socket.replyTo('after-cdc')).payload['status']).toBe('ok')
    },
    testTimeout
  )

  test(
    'presence follows subscribers across disconnect and reconnect',
    async () => {
      const backend = await startBackend()
      const alice = openClient(backend)
      alice.send(joinChannel('realtime:lobby', 'a1', { presence: { key: 'alice' } }))
      expect((await alice.socket.replyTo('a1')).payload['status']).toBe('ok')
      alice.send(track('realtime:lobby', 'a2', { name: 'Alice' }))
      expect((await alice.socket.replyTo('a2')).payload['status']).toBe('ok')

      const bob = openClient(backend, '2.0.0')
      bob.send(joinChannel('realtime:lobby', 'b1', { presence: { key: 'bob' } }))
      expect((await bob.socket.replyTo('b1')).payload['status']).toBe('ok')
      const snapshot = await bob.socket.event('presence_state')
      expect(Object.keys(snapshot.payload)).toEqual(['alice'])
      expect(snapshot.payload['alice']['metas'][0]['name']).toBe('Alice')

      alice.close()
      const leave = await bob.socket.event('presence_diff')
      expect(Object.keys(leave.payload['leaves'])).toEqual(['alice'])
      expect(Object.keys(leave.payload['joins'])).toEqual([])

      const aliceAgain = openClient(backend)
      aliceAgain.send(joinChannel('realtime:lobby', 'a3', { presence: { key: 'alice' } }))
      expect((await aliceAgain.socket.replyTo('a3')).payload['status']).toBe('ok')
      expect((await aliceAgain.socket.event('presence_state')).payload).toEqual({})

      const beforeRejoin = bob.socket.messages.length
      aliceAgain.send(track('realtime:lobby', 'a4', { name: 'Alice is back' }))
      expect((await aliceAgain.socket.replyTo('a4')).payload['status']).toBe('ok')
      const rejoin = await bob.socket.event('presence_diff', beforeRejoin)
      expect(rejoin.payload['joins']['alice']['metas'][0]['name']).toBe('Alice is back')
    },
    testTimeout
  )

  test(
    'private channel access follows realtime.messages RLS policies',
    async () => {
      const backend = await startBackend()
      const denied = openClient(backend)
      denied.send(joinChannel('realtime:secret', 'p1', { private: true, broadcast: { ack: true } }))
      const deniedReply = await denied.socket.replyTo('p1')
      expect(deniedReply.payload['status']).toBe('error')
      expect(deniedReply.payload['response']['reason']).toContain('permissions')

      await backend.db.engine.exec(
        `create policy rt_private_read on realtime.messages for select to anon using (realtime.topic() = topic)`
      )
      const reader = openClient(backend)
      reader.send(joinChannel('realtime:secret', 'p3', { private: true, broadcast: { ack: true } }))
      expect((await reader.socket.replyTo('p3')).payload['status']).toBe('ok')
      reader.send(sendBroadcast('realtime:secret', 'p4', 'denied', { n: 1 }))
      const rejected = await reader.socket.replyTo('p4')
      expect(rejected.payload['status']).toBe('error')
      expect(rejected.payload['response']['reason']).toBe('unauthorized')

      await backend.db.engine.exec(
        `create policy rt_private_write on realtime.messages for insert to anon with check (realtime.topic() = topic)`
      )
      reader.send({ topic: 'realtime:secret', event: 'access_token', ref: 'p5', payload: { access_token: 'refreshed' } })
      await Bun.sleep(50)
      reader.send(sendBroadcast('realtime:secret', 'p6', 'allowed', { n: 2 }))
      expect((await reader.socket.replyTo('p6')).payload['status']).toBe('ok')

      const observer = openClient(backend)
      observer.send(joinChannel('realtime:secret', 'p7', { private: true }))
      expect((await observer.socket.replyTo('p7')).payload['status']).toBe('ok')
      reader.send(sendBroadcast('realtime:secret', 'p8', 'relay', { n: 3 }))
      expect((await reader.socket.replyTo('p8')).payload['status']).toBe('ok')
      const relayed = await observer.socket.event('broadcast')
      expect(relayed.payload['payload']).toEqual({ n: 3 })
    },
    testTimeout
  )
})
