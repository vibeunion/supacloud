import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CdcEvent, Database } from '../src/runtime/db/database.js'
import { openRealtimeCore, type OpenedRealtimeCore } from '../src/runtime/realtime/core-asset.js'
import { realtimeCoreLibraryName } from '../src/runtime/realtime/core-ffi.js'
import { RealtimeEngine, type RealtimeSocketLike } from '../src/runtime/realtime/engine.js'

/**
 * TypeScript/Rust Realtime parity vectors.
 *
 * Every vector is a client-side wire script. The same script is replayed
 * against the default TypeScript engine and against the engine wired to the
 * Rust core; the frames each socket receives must be identical after
 * normalising generated identifiers. The database is a deterministic fake so
 * the comparison isolates protocol behaviour from PGlite timing.
 */

const packageDir = resolve(import.meta.dir, '..')
const libraryName = realtimeCoreLibraryName()
const libraryPath = [
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'debug', libraryName),
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'release', libraryName),
  join(packageDir, 'dist', 'native', libraryName),
].find((candidate) => existsSync(candidate))

const describeNative = libraryPath ? describe : describe.skip

interface Authz {
  read: boolean
  write: boolean
}

interface WireStep {
  socket: number
  frame?: unknown
  binary?: Uint8Array
  close?: boolean
  cdc?: CdcEvent
}

interface ParityVector {
  name: string
  steps: WireStep[]
  /** Consecutive RLS probe answers for private-channel vectors. */
  authz?: Authz[]
  /** Per-socket serializer override; the vector then runs once, not per vsn. */
  vsns?: string[]
}

class WireSocket implements RealtimeSocketLike {
  readonly sent: string[] = []
  closed = false
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : `<binary:${data.byteLength}>`)
  }
  close(): void {
    this.closed = true
  }
}

interface DriveResult {
  sockets: string[][]
  triggers: string[]
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    await new Promise<void>((done) => setImmediate(done))
  }
}

function fakeDatabase(authz?: Authz[]): { db: Database; triggers: string[] } {
  const triggers: string[] = []
  let authzCalls = 0
  const db = {
    engine: {
      minimalBootstrap: authz === undefined,
      transaction: async () => {
        const step = authz?.[Math.min(authzCalls, authz.length - 1)]
        authzCalls += 1
        throw { __authz: step ?? { read: false, write: false } }
      },
    },
    ensureCdcTrigger: async (schema: string, table: string) => {
      triggers.push(`${schema}.${table}`)
    },
    getSchemaInfo: async (schema: string) => ({
      tables: new Map(
        schema === 'public'
          ? [
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
              [
                'notes',
                {
                  columns: [
                    { name: 'id', udtName: 'int4' },
                    { name: 'body', udtName: 'text' },
                  ],
                  primaryKey: ['id'],
                },
              ],
            ]
          : []
      ),
    }),
    getRlsTables: async () => new Set<string>(),
    withContext: async () => ({ rows: [] }),
  } as unknown as Database
  return { db, triggers }
}

async function drive(
  engine: RealtimeEngine,
  vsns: string[],
  steps: WireStep[],
  triggers: string[]
): Promise<DriveResult> {
  const socketCount = steps.reduce((count, step) => Math.max(count, step.socket + 1), 0)
  const sockets = Array.from({ length: socketCount }, () => new WireSocket())
  const handlers = sockets.map((socket, index) => engine.connect(socket, { vsn: vsns[index] ?? vsns[0] }))
  const dispatchCdc = (engine as unknown as { dispatchCdc(event: CdcEvent): Promise<void> }).dispatchCdc.bind(engine)
  try {
    for (const step of steps) {
      if (step.cdc) {
        await dispatchCdc(step.cdc)
      } else if (step.close) {
        handlers[step.socket]!.onClose()
      } else if (step.binary) {
        handlers[step.socket]!.onMessage(step.binary)
      } else {
        handlers[step.socket]!.onMessage(JSON.stringify(step.frame))
      }
      await settle()
    }
  } finally {
    await engine.stop()
  }
  return { sockets: sockets.map((socket) => socket.sent), triggers: [...triggers] }
}

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/** Decode wire text so comparisons are structural rather than key-order sensitive. */
function stableSocket(sent: string[]): unknown[] {
  return sent.map((raw) => (raw.startsWith('<binary:') ? raw : stable(JSON.parse(raw))))
}

/** Sort object keys and replace generated identifiers so both engines compare structurally. */
function stable(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((entry) => stable(entry, path))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([rawKey, entry]) => {
          const key = UUID_PATTERN.test(rawKey) ? '<uuid>' : rawKey
          if (key === 'id' && path.at(-1) === 'postgres_changes') return [key, '<binding-id>']
          return [key, stable(entry, [...path, key])]
        })
    )
  }
  if (typeof value === 'string') {
    if (UUID_PATTERN.test(value)) return '<uuid>'
    if (/^F\d+$/.test(value)) return '<phx-ref>'
  }
  return value
}

const joinChannel = (socket: number, topic: string, ref: string, config: unknown, extra: Record<string, unknown> = {}): WireStep => ({
  socket,
  frame: { topic, event: 'phx_join', ref, payload: { config, ...extra } },
})
const heartbeat = (socket: number, ref: string): WireStep => ({
  socket,
  frame: { topic: 'phoenix', event: 'heartbeat', ref, payload: {} },
})
const broadcast = (socket: number, topic: string, event: string, payload: unknown, ref?: string): WireStep => ({
  socket,
  frame: {
    topic,
    event: 'broadcast',
    ...(ref === undefined ? {} : { ref }),
    payload: { type: 'broadcast', event, payload },
  },
})
const presence = (socket: number, topic: string, event: 'track' | 'untrack', payload: unknown, ref: string): WireStep => ({
  socket,
  frame: { topic, event: 'presence', ref, payload: { event, payload } },
})
const leave = (socket: number, topic: string, ref: string): WireStep => ({
  socket,
  frame: { topic, event: 'phx_leave', ref, payload: {} },
})
const cdc = (event: Omit<CdcEvent, 'commit_timestamp'>): WireStep => ({
  socket: 0,
  cdc: { ...event, commit_timestamp: '2026-01-01T00:00:00.000Z' },
})
const close = (socket: number): WireStep => ({ socket, close: true })

function binaryUserBroadcast(topic: string, event: string, payload: unknown, ref = '9'): Uint8Array {
  const encoder = new TextEncoder()
  const topicBytes = encoder.encode(topic)
  const eventBytes = encoder.encode(event)
  const refBytes = encoder.encode(ref)
  const payloadBytes = encoder.encode(JSON.stringify(payload))
  const out = new Uint8Array(7 + topicBytes.length + eventBytes.length + refBytes.length + payloadBytes.length)
  out[0] = 3
  out[1] = 0
  out[2] = refBytes.length
  out[3] = topicBytes.length
  out[4] = eventBytes.length
  out[5] = 0
  out[6] = 1
  out.set(refBytes, 7)
  out.set(topicBytes, 7 + refBytes.length)
  out.set(eventBytes, 7 + refBytes.length + topicBytes.length)
  out.set(payloadBytes, 7 + refBytes.length + topicBytes.length + eventBytes.length)
  return out
}

const VECTORS: ParityVector[] = [
  {
    name: 'heartbeat reply echoes the negotiated serializer',
    steps: [heartbeat(0, '1'), heartbeat(0, '2')],
  },
  {
    name: 'public join advertises bindings, presence snapshot and readiness signal',
    steps: [
      joinChannel(0, 'realtime:room', '1', {
        postgres_changes: [
          { event: 'INSERT', schema: 'public', table: 'todos', filter: 'done=eq.false' },
          { event: '*', schema: 'public', table: 'notes' },
        ],
      }),
    ],
  },
  {
    name: 'join with presence disabled skips the snapshot',
    steps: [
      joinChannel(0, 'realtime:quiet', '1', { presence: { enabled: false } }),
      presence(0, 'realtime:quiet', 'track', { name: 'ignored' }, '2'),
    ],
  },
  {
    name: 'wildcard table subscriptions attach triggers to every table',
    steps: [joinChannel(0, 'realtime:all', '1', { postgres_changes: [{ event: '*', schema: 'public', table: '*' }] })],
  },
  {
    name: 'CDC filtering, column metadata and multi-binding merge',
    steps: [
      joinChannel(0, 'realtime:cdc', '1', {
        postgres_changes: [
          { event: 'INSERT', schema: 'public', table: 'todos', filter: 'done=eq.false' },
          { event: '*', schema: 'public', table: 'todos' },
          { event: 'INSERT', schema: 'public', table: '*' },
        ],
      }),
      cdc({ schema: 'public', table: 'todos', type: 'INSERT', record: { id: 1, done: false }, old_record: null }),
      cdc({ schema: 'public', table: 'todos', type: 'INSERT', record: { id: 2, done: true }, old_record: null }),
      cdc({ schema: 'public', table: 'todos', type: 'UPDATE', record: { id: 1, done: true }, old_record: { id: 1, done: false } }),
      cdc({ schema: 'public', table: 'other', type: 'INSERT', record: { id: 3 }, old_record: null }),
      cdc({ schema: 'public', table: 'todos', type: 'DELETE', record: null, old_record: { id: 1, done: false } }),
    ],
  },
  {
    name: 'broadcast fan-out honours self echo and ack',
    steps: [
      joinChannel(0, 'realtime:chat', '1', { broadcast: { self: false, ack: true } }),
      joinChannel(1, 'realtime:chat', '1', { broadcast: { self: true, ack: false } }),
      broadcast(0, 'realtime:chat', 'cursor', { x: 1 }, '2'),
      broadcast(1, 'realtime:chat', 'cursor', { x: 2 }),
      broadcast(0, 'realtime:ghost', 'cursor', { x: 3 }, '3'),
    ],
  },
  {
    name: 'binary user broadcasts bypass the JSON core identically',
    steps: [
      joinChannel(0, 'realtime:bin', '1', { broadcast: { self: true } }),
      joinChannel(1, 'realtime:bin', '1', {}),
      { socket: 0, binary: binaryUserBroadcast('realtime:bin', 'blob', { ok: true }) },
    ],
  },
  {
    name: 'presence track, retrack, untrack and leave',
    steps: [
      joinChannel(0, 'realtime:presence', '1', { presence: { key: 'alice' } }),
      joinChannel(1, 'realtime:presence', '1', { presence: { key: 'bob' } }),
      joinChannel(2, 'realtime:presence', '1', {}),
      presence(0, 'realtime:presence', 'track', { name: 'Ada' }, '2'),
      presence(2, 'realtime:presence', 'track', { name: 'Cyr' }, '2'),
      presence(0, 'realtime:presence', 'track', { name: 'Ada Lovelace' }, '3'),
      presence(0, 'realtime:presence', 'untrack', {}, '4'),
      presence(0, 'realtime:presence', 'untrack', {}, '5'),
      presence(0, 'realtime:ghost', 'track', { name: 'nobody' }, '6'),
      presence(0, 'realtime:presence', 'track', { name: 'Ada again' }, '7'),
      leave(0, 'realtime:presence', '8'),
    ],
  },
  {
    name: 'disconnect emits presence leaves to the remaining sockets',
    steps: [
      joinChannel(0, 'realtime:presence', '1', { presence: { key: 'alice' } }),
      joinChannel(1, 'realtime:presence', '1', { presence: { key: 'bob' } }),
      joinChannel(0, 'realtime:other', '1', { presence: { key: 'alice' } }),
      joinChannel(1, 'realtime:other', '1', {}),
      presence(0, 'realtime:other', 'track', { name: 'other' }, '2'),
      presence(0, 'realtime:presence', 'track', { name: 'main' }, '3'),
      close(0),
      presence(1, 'realtime:presence', 'track', { name: 'Bob' }, '4'),
    ],
  },
  {
    name: 'rejoining the same topic replaces the channel',
    steps: [
      joinChannel(0, 'realtime:room', '1', { broadcast: { self: false } }),
      joinChannel(1, 'realtime:room', '1', { broadcast: { self: true } }),
      joinChannel(0, 'realtime:room', '2', { broadcast: { self: true } }),
      broadcast(0, 'realtime:room', 'after-rejoin', { n: 1 }, '3'),
      leave(0, 'realtime:room', '4'),
      broadcast(0, 'realtime:room', 'after-leave', { n: 2 }, '5'),
    ],
  },
  {
    name: 'private channel read-only authorization rejects acked broadcasts',
    authz: [{ read: true, write: false }],
    steps: [
      joinChannel(0, 'realtime:secret', '1', { private: true, broadcast: { ack: true } }),
      broadcast(0, 'realtime:secret', 'denied', { n: 1 }, '2'),
      broadcast(0, 'realtime:secret', 'denied-silent', { n: 2 }),
      joinChannel(1, 'realtime:secret', '1', { private: true }),
      broadcast(1, 'realtime:secret', 'relayed', { n: 3 }, '2'),
    ],
  },
  {
    name: 'private channel denial reports the RLS reason',
    authz: [{ read: false, write: false }],
    steps: [joinChannel(0, 'realtime:secret', '1', { private: true }), broadcast(0, 'realtime:secret', 'x', {}, '2')],
  },
  {
    name: 'token refresh re-evaluates private write access',
    authz: [
      { read: true, write: false },
      { read: true, write: true },
    ],
    steps: [
      joinChannel(0, 'realtime:secret', '1', { private: true, broadcast: { ack: true } }),
      broadcast(0, 'realtime:secret', 'before', { n: 1 }, '2'),
      { socket: 0, frame: { topic: 'realtime:secret', event: 'access_token', ref: '3', payload: { access_token: 'refreshed' } } },
      broadcast(0, 'realtime:secret', 'after', { n: 2 }, '4'),
    ],
  },
  {
    name: 'mixed serializers per connection',
    vsns: ['2.0.0', '1.0.0'],
    steps: [
      joinChannel(0, 'realtime:mixed', '1', {}),
      joinChannel(1, 'realtime:mixed', '1', {}),
      heartbeat(0, '2'),
      heartbeat(1, '3'),
      broadcast(0, 'realtime:mixed', 'to-v1', { n: 1 }, '4'),
      broadcast(1, 'realtime:mixed', 'to-v2', { n: 2 }, '5'),
    ],
  },
  {
    name: 'unknown events are ignored',
    steps: [{ socket: 0, frame: { topic: 'realtime:room', event: 'phx_mystery', ref: '1', payload: {} } }, heartbeat(0, '2')],
  },
]

describeNative('TypeScript/Rust Realtime parity vectors', () => {
  let opened: OpenedRealtimeCore

  beforeAll(async () => {
    opened = await openRealtimeCore({ path: libraryPath, ignoreEmbedded: true, env: {} })
  })

  afterAll(async () => {
    await opened?.close()
  })

  for (const vector of VECTORS) {
    const variants: Array<{ label: string; vsns: string[] }> = vector.vsns
      ? [{ label: 'mixed', vsns: vector.vsns }]
      : [
          { label: 'v1', vsns: ['1.0.0'] },
          { label: 'v2', vsns: ['2.0.0'] },
        ]
    for (const variant of variants) {
      test(`${variant.label}: ${vector.name}`, async () => {
        const typescriptDb = fakeDatabase(vector.authz)
        const rustDb = fakeDatabase(vector.authz)
        const typescript = await drive(
          new RealtimeEngine(typescriptDb.db),
          variant.vsns,
          vector.steps,
          typescriptDb.triggers
        )
        const rust = await drive(
          new RealtimeEngine(rustDb.db, undefined, undefined, { core: opened.core }),
          variant.vsns,
          vector.steps,
          rustDb.triggers
        )
        expect(rust.sockets.map(stableSocket)).toEqual(typescript.sockets.map(stableSocket))
        expect(rust.triggers).toEqual(typescript.triggers)
      })
    }
  }
})
