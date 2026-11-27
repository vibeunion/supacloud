import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RealtimeEngine, type RealtimeSocketLike } from '../src/runtime/realtime/engine.js'
import type { OpenedRealtimeCore } from '../src/runtime/realtime/core-asset.js'
import { openRealtimeCore } from '../src/runtime/realtime/core-asset.js'
import { realtimeCoreLibraryName } from '../src/runtime/realtime/core-ffi.js'
import type { Database } from '../src/runtime/db/database.js'

const packageDir = resolve(import.meta.dir, '..')
const libraryName = realtimeCoreLibraryName()
const libraryPath = [
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'debug', libraryName),
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'release', libraryName),
  join(packageDir, 'dist', 'native', libraryName),
].find((candidate) => existsSync(candidate))

const describeNative = libraryPath ? describe : describe.skip

interface Decoded {
  topic: string
  event: string
  payload: Record<string, unknown>
  ref?: string | null
  join_ref?: string | null
}

class TestSocket implements RealtimeSocketLike {
  sent: unknown[] = []
  closed = false
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data)
  }
  close(): void {
    this.closed = true
  }
  events(event: string): Decoded[] {
    return this.sent.filter(
      (message): message is Decoded =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        (message as Decoded).event === event
    )
  }
}

function fakeDatabase(overrides: Record<string, unknown> = {}): Database {
  return {
    engine: { minimalBootstrap: true },
    ensureCdcTrigger: async () => {},
    getSchemaInfo: async () => ({
      tables: new Map([
        [
          'todos',
          {
            columns: [
              { name: 'id', udtName: 'int4' },
              { name: 'done', udtName: 'bool' },
            ],
            primaryKey: ['id'],
          },
        ],
      ]),
    }),
    getRlsTables: async () => new Set<string>(),
    ...overrides,
  } as unknown as Database
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describeNative('RealtimeEngine with the Rust core', () => {
  let opened: OpenedRealtimeCore
  let engine: RealtimeEngine

  beforeAll(async () => {
    opened = await openRealtimeCore({ path: libraryPath, ignoreEmbedded: true, env: {} })
    engine = new RealtimeEngine(fakeDatabase(), undefined, undefined, { core: opened.core })
  })

  afterAll(async () => {
    await engine?.stop()
    await opened?.close()
  })

  test('handles heartbeat through the core', async () => {
    const socket = new TestSocket()
    const { onMessage } = engine.connect(socket, { vsn: '2.0.0' })
    onMessage(JSON.stringify([null, '1', 'phoenix', 'heartbeat', {}]))
    await flush()
    expect(socket.sent[0]).toEqual([
      null,
      '1',
      'phoenix',
      'phx_reply',
      { status: 'ok', response: {} },
    ])
  })

  test('joins, advertises bindings and emits the readiness signal', async () => {
    const socket = new TestSocket()
    const { onMessage } = engine.connect(socket, { vsn: '1.0.0' })
    onMessage(
      JSON.stringify({
        join_ref: '1',
        ref: '2',
        topic: 'realtime:room',
        event: 'phx_join',
        payload: {
          config: {
            postgres_changes: [
              { event: 'INSERT', schema: 'public', table: 'todos', filter: 'done=eq.false' },
            ],
          },
        },
      })
    )
    await flush()

    const reply = socket.events('phx_reply')[0]
    expect(reply.payload.status).toBe('ok')
    const changes = (reply.payload.response as { postgres_changes: { id: number }[] }).postgres_changes
    expect(changes).toHaveLength(1)
    expect(socket.events('presence_state')).toHaveLength(1)
    const system = socket.events('system')[0]
    expect((system.payload as { extension: string }).extension).toBe('postgres_changes')
  })

  test('filters CDC events and keeps column metadata', async () => {
    const socket = new TestSocket()
    const { onMessage } = engine.connect(socket, { vsn: '1.0.0' })
    onMessage(
      JSON.stringify({
        topic: 'realtime:cdc',
        event: 'phx_join',
        payload: {
          config: {
            postgres_changes: [
              { event: 'INSERT', schema: 'public', table: 'todos', filter: 'done=eq.false' },
            ],
          },
        },
        ref: '1',
      })
    )
    await flush()

    const dispatch = (engine as unknown as { dispatchCdc: (event: unknown) => Promise<void> }).dispatchCdc.bind(engine)
    await dispatch({
      schema: 'public',
      table: 'todos',
      type: 'INSERT',
      commit_timestamp: '2026-01-01T00:00:00Z',
      record: { id: 1, done: false },
      old_record: null,
    })
    await flush()

    const changes = socket.events('postgres_changes')
    expect(changes).toHaveLength(1)
    const data = changes[0].payload.data as {
      eventType: string
      columns: { name: string }[]
      record: { id: number }
    }
    expect(data.eventType).toBe('INSERT')
    expect(data.columns.map((column) => column.name)).toEqual(['id', 'done'])
    expect(data.record.id).toBe(1)

    const before = socket.events('postgres_changes').length
    await dispatch({
      schema: 'public',
      table: 'todos',
      type: 'INSERT',
      commit_timestamp: '2026-01-01T00:00:01Z',
      record: { id: 2, done: true },
      old_record: null,
    })
    await flush()
    expect(socket.events('postgres_changes')).toHaveLength(before)
  })

  test('fans out broadcasts without echoing the sender by default', async () => {
    const sender = new TestSocket()
    const receiver = new TestSocket()
    const a = engine.connect(sender)
    const b = engine.connect(receiver)
    for (const { onMessage } of [a, b]) {
      onMessage(
        JSON.stringify({
          topic: 'realtime:chat',
          event: 'phx_join',
          payload: { config: { broadcast: { self: false } } },
          ref: '1',
        })
      )
    }
    await flush()
    a.onMessage(
      JSON.stringify({
        topic: 'realtime:chat',
        event: 'broadcast',
        payload: { type: 'broadcast', event: 'cursor', payload: { x: 1 } },
        ref: '2',
      })
    )
    await flush()

    expect(receiver.events('broadcast')).toHaveLength(1)
    expect(sender.events('broadcast')).toHaveLength(0)
    b.onClose()
  })

  test('denies private channels when RLS rejects the subscriber', async () => {
    const db = fakeDatabase({
      engine: {
        minimalBootstrap: false,
        transaction: async () => {
          throw { __authz: { read: false, write: false } }
        },
      },
    })
    const isolated = new RealtimeEngine(db, undefined, undefined, { core: opened.core })
    const socket = new TestSocket()
    const { onMessage } = isolated.connect(socket)
    onMessage(
      JSON.stringify({
        topic: 'realtime:secret',
        event: 'phx_join',
        payload: { config: { private: true } },
        ref: '1',
      })
    )
    await flush()
    await flush()

    const reply = socket.events('phx_reply')[0]
    expect(reply.payload.status).toBe('error')
    expect((reply.payload.response as { reason: string }).reason).toContain('permissions')
    await isolated.stop()
  })

  test('keeps a large broadcast payload out of the core request', async () => {
    const requests: unknown[] = []
    const isolated = new RealtimeEngine(fakeDatabase(), undefined, undefined, {
      core: {
        call: (request) => {
          requests.push(request)
          return opened.core.call(request)
        },
        close: () => {},
      },
    })
    const sockets = Array.from({ length: 3 }, () => new TestSocket())
    const handlers = sockets.map((socket) => isolated.connect(socket, { vsn: '1.0.0' }))
    for (const handler of handlers) {
      handler.onMessage(
        JSON.stringify({
          join_ref: '1',
          ref: '1',
          topic: 'realtime:room',
          event: 'phx_join',
          payload: { config: { broadcast: { self: false } } },
        })
      )
    }
    await flush()

    const blob = 'x'.repeat(64 * 1024)
    handlers[0]!.onMessage(
      JSON.stringify({
        join_ref: '1',
        ref: '2',
        topic: 'realtime:room',
        event: 'broadcast',
        payload: { type: 'broadcast', event: 'm', payload: { blob } },
      })
    )
    await flush()

    const request = JSON.stringify(requests.at(-1))
    expect(request).toContain('sc_payload_ref')
    expect(request).not.toContain(blob)
    for (const socket of sockets.slice(1)) {
      expect(socket.events('broadcast')[0]?.payload.payload).toEqual({ blob })
    }
    await isolated.stop()
  })

  test('keeps a large CDC record out of the core response', async () => {
    const requests: unknown[] = []
    const responses: unknown[] = []
    const isolated = new RealtimeEngine(fakeDatabase(), undefined, undefined, {
      core: {
        call: (request) => {
          requests.push(request)
          const response = opened.core.call(request)
          responses.push(response)
          return response
        },
        close: () => {},
      },
    })
    const socket = new TestSocket()
    const { onMessage } = isolated.connect(socket, { vsn: '1.0.0' })
    onMessage(
      JSON.stringify({
        topic: 'realtime:cdc',
        event: 'phx_join',
        ref: '1',
        payload: {
          config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'todos' }] },
        },
      })
    )
    await flush()

    const blob = 'x'.repeat(64 * 1024)
    const dispatch = (isolated as unknown as { dispatchCdc: (event: unknown) => Promise<void> }).dispatchCdc.bind(
      isolated
    )
    await dispatch({
      schema: 'public',
      table: 'todos',
      type: 'INSERT',
      commit_timestamp: '2026-01-01T00:00:00Z',
      record: { id: 1, done: false, blob },
      old_record: null,
    })
    await flush()

    // The record still crosses once so the core can match filters, but the
    // fan-out frames come back carrying the marker instead of N copies.
    expect(JSON.stringify(requests.at(-1))).toContain('record_ref')
    const response = JSON.stringify(responses.at(-1))
    expect(response).toContain('sc_payload_ref')
    expect(response).not.toContain(blob)

    const data = socket.events('postgres_changes')[0]?.payload.data as { record: { blob: string } }
    expect(data.record.blob).toBe(blob)
    await isolated.stop()
  })

  test('ownsCore releases the core on stop', async () => {
    let closed = 0
    const isolated = new RealtimeEngine(fakeDatabase(), undefined, undefined, {
      core: {
        call: () => ({ frames: [], effects: [], errors: [] }),
        close: () => {
          closed += 1
        },
      },
      ownsCore: true,
    })
    await isolated.stop()
    expect(closed).toBe(1)
  })

  test('a borrowed core is not released by the engine', async () => {
    let closed = 0
    const isolated = new RealtimeEngine(fakeDatabase(), undefined, undefined, {
      core: {
        call: () => ({ frames: [], effects: [], errors: [] }),
        close: () => {
          closed += 1
        },
      },
    })
    await isolated.stop()
    expect(closed).toBe(0)
  })
})
