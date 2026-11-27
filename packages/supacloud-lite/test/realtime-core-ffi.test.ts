import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  openRealtimeCore,
  type OpenedRealtimeCore,
} from '../src/runtime/realtime/core-asset.js'
import {
  REALTIME_CORE_ABI_VERSION,
  realtimeCoreLibraryName,
  type CoreResponse,
} from '../src/runtime/realtime/core-ffi.js'

const packageDir = resolve(import.meta.dir, '..')
const libraryName = realtimeCoreLibraryName()
const libraryPath = [
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'debug', libraryName),
  join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'release', libraryName),
  join(packageDir, 'dist', 'native', libraryName),
].find((candidate) => existsSync(candidate))

const describeNative = libraryPath ? describe : describe.skip

describeNative('realtime core FFI', () => {
  let opened: OpenedRealtimeCore

  beforeAll(async () => {
    opened = await openRealtimeCore({
      path: libraryPath,
      ignoreEmbedded: true,
      env: {},
    })
  })

  afterAll(async () => {
    await opened?.close()
  })

  const call = (request: Parameters<OpenedRealtimeCore['core']['call']>[0]): CoreResponse =>
    opened.core.call(request)

  test('reports the ABI version', () => {
    expect(opened.core.abiVersion).toBe(REALTIME_CORE_ABI_VERSION)
  })

  test('answers heartbeat frames', () => {
    const out = call({
      op: 'frame',
      connection_id: 'c1',
      frame: ['1', '1', 'phoenix', 'heartbeat', {}],
    })
    expect(out.errors).toEqual([])
    expect(out.frames).toHaveLength(1)
    expect(out.frames[0].connection_id).toBe('c1')
    const frame = out.frames[0].frame as unknown[]
    expect(frame[3]).toBe('phx_reply')
    expect((frame[4] as { status: string }).status).toBe('ok')
  })

  test('joins a public channel and delivers matching CDC events', () => {
    const joined = call({
      op: 'frame',
      connection_id: 'c2',
      frame: [
        '1',
        '2',
        'realtime:room',
        'phx_join',
        {
          config: {
            postgres_changes: [
              {
                event: 'INSERT',
                schema: 'public',
                table: 'todos',
                filter: 'done=eq.false',
              },
            ],
          },
        },
      ],
    })
    expect(joined.errors).toEqual([])
    const reply = joined.frames[0].frame as unknown[]
    expect((reply[4] as { status: string }).status).toBe('ok')

    const delivered = call({
      op: 'cdc',
      event: {
        schema: 'public',
        table: 'todos',
        type: 'INSERT',
        record: { id: 1, done: false },
      },
    })
    expect(delivered.frames).toHaveLength(1)

    const filtered = call({
      op: 'cdc',
      event: {
        schema: 'public',
        table: 'todos',
        type: 'INSERT',
        record: { id: 2, done: true },
      },
    })
    expect(filtered.frames).toHaveLength(0)
  })

  test('private joins ask the host for RLS authorization', () => {
    const joined = call({
      op: 'frame',
      connection_id: 'c3',
      frame: [
        '1',
        '3',
        'realtime:secret',
        'phx_join',
        { config: { private: true } },
      ],
    })
    expect(joined.frames).toHaveLength(0)
    expect(joined.effects).toHaveLength(1)
    const effect = joined.effects[0]
    expect(effect.type).toBe('authorize')
    if (effect.type !== 'authorize') throw new Error('unreachable')

    const denied = call({
      op: 'authorize_result',
      connection_id: 'c3',
      request_id: effect.request_id,
      read: false,
      write: false,
    })
    const reply = denied.frames[0].frame as unknown[]
    expect((reply[4] as { status: string }).status).toBe('error')
    expect((reply[4] as { response: { reason: string } }).response.reason).toBe(
      'Unauthorized'
    )
  })

  test('disconnects release channel state', () => {
    const out = call({ op: 'disconnect', connection_id: 'c2' })
    expect(out.errors).toEqual([])
  })
})