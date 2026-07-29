import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from './helpers/supacloud-js-source.js'
import { createLiteBackend, type PgredisCacheBinding, type SupaCloudLiteBackend } from '../src/index.js'

const backendConfig = {
  jwtSecret: 'x'.repeat(64),
  vaultKey: 'y'.repeat(64),
  log: () => {},
}

describe('Queues compatibility', () => {
  test('supports raw pgmq operations and the pgmq_public client façade', async () => {
    const backend = await createLiteBackend(backendConfig)
    try {
      await backend.db.query(`select pgmq.create('raw_jobs')`)
      const rawSent = await backend.db.query<{ msg_id: number }>(
        `select pgmq.send('raw_jobs', '{"source":"raw"}'::jsonb, 0) as msg_id`
      )
      const rawId = rawSent.rows[0]!.msg_id
      const rawRead = await backend.db.query<{ msg_id: number }>(`select * from pgmq.read('raw_jobs', 30, 1)`)
      expect(rawRead.rows.map((message) => message.msg_id)).toEqual([rawId])
      expect((await backend.db.query(`select * from pgmq.set_vt('raw_jobs', ${rawId}, 0)`)).rows).toHaveLength(1)
      expect((await backend.db.query(`select pgmq.archive('raw_jobs', ${rawId}) as archived`)).rows[0]).toEqual({ archived: true })

      const client = createClient('http://local', backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: backend.fetch },
      })
      const queues = client.schema('pgmq_public')
      await backend.db.query(`select pgmq.create('client_jobs')`)
      const sent = await queues.rpc('send', {
        queue_name: 'client_jobs',
        message: { sequence: 1 },
        sleep_seconds: 0,
      })
      const batch = await queues.rpc('send_batch', {
        queue_name: 'client_jobs',
        messages: [{ sequence: 2 }, { sequence: 3 }],
        sleep_seconds: 0,
      })
      expect(sent.error).toBeNull()
      expect(sent.data).toEqual([1])
      expect(batch.error).toBeNull()
      expect(batch.data).toEqual([2, 3])

      const read = await queues.rpc('read', { queue_name: 'client_jobs', sleep_seconds: 30, n: 2 })
      expect(read.error).toBeNull()
      const messages = read.data as Array<{ msg_id: number; message: { sequence: number } }>
      expect(messages.map((message) => message.msg_id)).toEqual([1, 2])
      expect(messages.map((message) => message.message)).toEqual([{ sequence: 1 }, { sequence: 2 }])
      expect((await queues.rpc('archive', { queue_name: 'client_jobs', message_id: 1 })).data).toBe(true)
      expect((await queues.rpc('delete', { queue_name: 'client_jobs', message_id: 2 })).data).toBe(true)

      const popped = await queues.rpc('pop', { queue_name: 'client_jobs' })
      expect(popped.error).toBeNull()
      expect(popped.data?.[0]).toMatchObject({ msg_id: 3, message: { sequence: 3 } })
      expect((await queues.rpc('pop', { queue_name: 'client_jobs' })).data).toEqual([])
    } finally {
      await backend.close()
    }
  })

  test('supports the @supacloud/js queue client end to end', async () => {
    const backend = await createLiteBackend(backendConfig)
    try {
      const supabase = createClient('http://local', backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: backend.fetch },
      })
      const client = createSupaCloudClient({
        supabase,
        managementApiUrl: 'http://management-not-used',
        projectRef: 'lite',
      })
      const queue = client.queue('sdk_jobs')
      await backend.db.query(`select pgmq.create('sdk_jobs')`)

      const sent = await queue.send({ sequence: 1 })
      const batch = await queue.sendBatch([{ sequence: 2 }, { sequence: 3 }, { sequence: 4 }])
      expect(sent).toMatchObject({ msg_id: 1, queue_name: 'sdk_jobs', status: 'pending' })
      expect(batch.map((message) => message.msg_id)).toEqual([2, 3, 4])

      const received = await queue.receive({ visibilityTimeoutSec: 30 })
      expect(received).toMatchObject({ msg_id: 1, payload: { sequence: 1 }, status: 'leased' })
      expect(await queue.ack(received!.msg_id)).toMatchObject({ msg_id: 1, status: 'archived', success: true })

      const messages = await queue.read({ sleepSeconds: 30, n: 3 })
      expect(messages.map((message) => message.payload)).toEqual([
        { sequence: 2 },
        { sequence: 3 },
        { sequence: 4 },
      ])
      expect(await queue.archive(messages[0]!.msg_id)).toMatchObject({ msg_id: 2, status: 'archived', success: true })
      expect(await queue.delete(messages[1]!.msg_id)).toMatchObject({ msg_id: 3, status: 'deleted', success: true })
      expect(await queue.delete(messages[2]!.msg_id)).toMatchObject({ msg_id: 4, status: 'deleted', success: true })
      expect(await queue.receive()).toBeNull()
    } finally {
      await backend.close()
    }
  })

  test('requires queue creation and respects explicit exposed schemas', async () => {
    const backend = await createLiteBackend(backendConfig)
    const restricted = await createLiteBackend({ ...backendConfig, dbSchemas: ['public'] })
    try {
      const client = createClient('http://local', backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: backend.fetch },
      })
      const missing = await client.schema('pgmq_public').rpc('send', {
        queue_name: 'not_created',
        message: { rejected: true },
        sleep_seconds: 0,
      })
      expect(missing.data).toBeNull()
      expect(missing.error).not.toBeNull()

      await restricted.db.query(`select pgmq.create('hidden_queue')`)
      const restrictedClient = createClient('http://local', restricted.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: restricted.fetch },
      })
      const hidden = await restrictedClient.schema('pgmq_public').rpc('send', {
        queue_name: 'hidden_queue',
        message: { rejected: true },
        sleep_seconds: 0,
      })
      expect(hidden.data).toBeNull()
      expect(hidden.error).not.toBeNull()
    } finally {
      await Promise.all([backend.close(), restricted.close()])
    }
  })

  test('keeps valid long queue names isolated without identifier truncation', async () => {
    const backend = await createLiteBackend(backendConfig)
    const prefix = 'q'.repeat(61)
    const firstQueue = `${prefix}a`
    const secondQueue = `${prefix}b`
    const maxLengthQueue = 'm'.repeat(128)
    try {
      await backend.db.query(`select pgmq.create($1), pgmq.create($2), pgmq.create($3)`, [
        firstQueue,
        secondQueue,
        maxLengthQueue,
      ])
      await expect(backend.db.query(`select pgmq.create($1)`, ['x'.repeat(129)])).rejects.toThrow('invalid queue name')
      await backend.db.query(`select pgmq.send($1, '{"queue":"first"}'::jsonb, 0)`, [firstQueue])
      await backend.db.query(`select pgmq.send($1, '{"queue":"second"}'::jsonb, 0)`, [secondQueue])

      const first = await backend.db.query<{ message: { queue: string } }>(`select * from pgmq.read($1, 30, 10)`, [firstQueue])
      const second = await backend.db.query<{ message: { queue: string } }>(`select * from pgmq.read($1, 30, 10)`, [secondQueue])
      expect(first.rows.map((message) => message.message.queue)).toEqual(['first'])
      expect(second.rows.map((message) => message.message.queue)).toEqual(['second'])

      const metadata = await backend.db.query<{ queue_name: string; physical_name: string }>(
        `select queue_name, physical_name from pgmq.meta where queue_name = any($1::text[]) order by queue_name`,
        [[firstQueue, secondQueue]]
      )
      expect(metadata.rows.map((queue) => queue.queue_name)).toEqual([firstQueue, secondQueue])
      expect(new Set(metadata.rows.map((queue) => queue.physical_name)).size).toBe(2)
      expect(metadata.rows.every((queue) => queue.physical_name.length <= 61)).toBe(true)
      expect((await backend.db.query(`select 1 from pgmq.meta where queue_name = $1`, [maxLengthQueue])).rows).toHaveLength(1)
    } finally {
      await backend.close()
    }
  })
})

describe('Edge Function pgredis compatibility', () => {
  test('keeps the cache table private from Data API roles', async () => {
    const backend = await createLiteBackend(backendConfig)
    try {
      for (const key of [backend.anonKey, backend.serviceRoleKey]) {
        const client = createClient('http://local', key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: backend.fetch },
        })
        const result = await client.from('supacloud_pgredis_kv').select('*')
        expect(result.data).toBeNull()
        expect(result.error?.code).toBe('42501')
      }
    } finally {
      await backend.close()
    }
  })

  test('enforces the standard key, JSON value, and TTL limits', async () => {
    const backend = await createLiteBackend({
      ...backendConfig,
      functions: {
        boundaries: async () => {
          const cache = pgredis()
          const maxKey = 'k'.repeat(512)
          const maxValue = 'v'.repeat(1_048_574)
          await cache.set(maxKey, maxValue, 31_536_000_000)
          const acceptedLength = (await cache.get<string>(maxKey))?.length
          await cache.delete(maxKey)
          return Response.json({
            acceptedLength,
            keyError: await capturedError(() => cache.get('k'.repeat(513))),
            valueError: await capturedError(() => cache.set('large', 'v'.repeat(1_048_575))),
            ttlError: await capturedError(() => cache.set('ttl', true, 31_536_000_001)),
          })
        },
      },
    })
    try {
      const boundaries = await invoke(backend, 'boundaries') as Record<string, unknown>
      expect(boundaries.acceptedLength).toBe(1_048_574)
      expect(boundaries.keyError).toContain('512 characters')
      expect(boundaries.valueError).toContain('1048576 bytes')
      expect(boundaries.ttlError).toContain('31536000000')
    } finally {
      await backend.close()
    }
  })

  test('supports TTL cleanup and atomic getset/getdel', async () => {
    const backend = await createLiteBackend({
      ...backendConfig,
      functions: {
        ttl: async () => {
          const cache = pgredis()
          await cache.set('expires', { version: 1 }, 40)
          return Response.json({ cached: await cache.get('expires'), ttlMs: await cache.ttl('expires') })
        },
        expired: async () => Response.json({ cached: await pgredis().get('expires') }),
        atomic: async () => {
          const cache = pgredis()
          await cache.set('swap', 0)
          const previous = await Promise.all(
            Array.from({ length: 8 }, (_, index) => cache.getset('swap', index + 1))
          )
          const current = await cache.get<number>('swap')
          await cache.set('take-once', { present: true })
          const deleted = await Promise.all([cache.getdel('take-once'), cache.getdel('take-once')])
          return Response.json({ previous, current, deleted })
        },
      },
    })
    try {
      const initial = await invoke(backend, 'ttl') as { cached: unknown; ttlMs: number }
      expect(initial.cached).toEqual({ version: 1 })
      expect(initial.ttlMs).toBeGreaterThan(0)
      expect(initial.ttlMs).toBeLessThanOrEqual(40)
      await Bun.sleep(60)
      expect(await invoke(backend, 'expired')).toEqual({ cached: null })
      const remaining = await backend.db.query<{ count: number }>(
        `select count(*)::int as count from public.supacloud_pgredis_kv where key = 'expires'`
      )
      expect(remaining.rows[0]?.count).toBe(0)

      const atomic = await invoke(backend, 'atomic') as {
        previous: number[]
        current: number
        deleted: Array<{ present: boolean } | null>
      }
      expect([...atomic.previous, atomic.current].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(atomic.deleted.filter((cacheValue) => cacheValue !== null)).toEqual([{ present: true }])
    } finally {
      await backend.close()
    }
  })

  test('keeps cached facades project- and request-scoped', async () => {
    const first = await createLiteBackend(backendConfig)
    const cachedFacade = pgredis()
    let detachedOutcome = ''
    const cacheFunction = async (request: Request) => {
      const command = await request.json() as { operation: 'get' | 'set' | 'detach'; cacheValue?: string }
      if (command.operation === 'set') {
        await cachedFacade.set('shared', command.cacheValue)
        return new Response(null, { status: 204 })
      }
      if (command.operation === 'detach') {
        void Bun.sleep(30).then(async () => {
          try {
            await cachedFacade.get('shared')
            detachedOutcome = 'unexpected access'
          } catch (error) {
            detachedOutcome = error instanceof Error ? error.message : String(error)
          }
        })
        return Response.json({ scheduled: true }, { status: 202 })
      }
      return Response.json({ cacheValue: await cachedFacade.get('shared') })
    }
    first.functions.register('cache', cacheFunction)
    const second = await createLiteBackend(backendConfig)
    second.functions.register('cache', cacheFunction)

    try {
      await Promise.all([
        invoke(first, 'cache', { operation: 'set', cacheValue: 'first' }),
        invoke(second, 'cache', { operation: 'set', cacheValue: 'second' }),
      ])
      expect(await invoke(first, 'cache', { operation: 'get' })).toEqual({ cacheValue: 'first' })
      expect(await invoke(second, 'cache', { operation: 'get' })).toEqual({ cacheValue: 'second' })
      await expect(cachedFacade.get('shared')).rejects.toThrow('outside a function request')

      await invoke(first, 'cache', { operation: 'detach' })
      await Bun.sleep(60)
      expect(detachedOutcome).toContain('outside a function request')
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  test('persists cache entries with a file-backed PGlite project', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-pgredis-'))
    const dataDir = join(projectDir, 'db')
    const cacheFunction = async (request: Request) => {
      const command = await request.json() as { cacheValue?: string }
      if (command.cacheValue !== undefined) await pgredis().set('persistent', command.cacheValue)
      return Response.json({ cacheValue: await pgredis().get('persistent') })
    }
    try {
      const first = await createLiteBackend({ ...backendConfig, dataDir, functions: { cache: cacheFunction } })
      expect(await invoke(first, 'cache', { cacheValue: 'kept' })).toEqual({ cacheValue: 'kept' })
      await first.close()

      const reopened = await createLiteBackend({ ...backendConfig, dataDir, functions: { cache: cacheFunction } })
      try {
        expect(await invoke(reopened, 'cache', {})).toEqual({ cacheValue: 'kept' })
      } finally {
        await reopened.close()
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

function pgredis(): PgredisCacheBinding {
  return (globalThis as typeof globalThis & { SupaCloud: { pgredis: PgredisCacheBinding } }).SupaCloud.pgredis
}

async function invoke(backend: SupaCloudLiteBackend, functionName: string, body?: unknown): Promise<unknown> {
  const response = await backend.fetch(`http://local/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { apikey: backend.anonKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`function ${functionName} returned ${response.status}: ${await response.text()}`)
  if (response.status === 204) return null
  return response.json()
}

async function capturedError(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
