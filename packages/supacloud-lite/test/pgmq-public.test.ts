import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createSupaCloudClient } from '../../supacloud-js/src/index.js'
import { createBackend } from '../src/runtime/index.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

test('Lite public queue RPCs preserve bigint receipts and reject invalid mutations', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  const query = async (sql: string, params?: unknown[]) =>
    (await backend.db.query<Record<string, unknown>>(sql, params)).rows
  try {
    await query("select pgmq.create('receipt_test')")
    await query('alter table pgmq.q_receipt_test alter column msg_id restart with 9007199254740993')
    await query('set role anon')
    expect(await query(
      "select pgmq_public.send('receipt_test', $1::jsonb) as id",
      [JSON.stringify({ nested: [true, null, 'value'] })],
    )).toEqual([{ id: '9007199254740993' }])
    expect(await query(
      "select pgmq_public.send_batch('receipt_test', array['null'::jsonb, '42'::jsonb]) as id",
    )).toEqual([{ id: '9007199254740994' }, { id: '9007199254740995' }])

    const read = await query("select * from pgmq_public.read('receipt_test', 0, 1)")
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({
      msg_id: '9007199254740993', read_ct: 1,
      message: { nested: [true, null, 'value'] },
      last_read_at: null, headers: null,
    })
    expect(Object.keys(read[0] ?? {}).sort()).toEqual([
      'enqueued_at', 'headers', 'last_read_at', 'message', 'msg_id', 'read_ct', 'vt',
    ])
    expect(await query("select * from pgmq_public.pop('receipt_test')")).toEqual(read)
    expect(await query("select pgmq_public.archive('receipt_test', '9007199254740994') as ok"))
      .toEqual([{ ok: true }])
    expect(await query("select pgmq_public.delete('receipt_test', '9007199254740995') as ok"))
      .toEqual([{ ok: true }])
    expect(await query("select * from pgmq_public.read('receipt_test', 0, 1)")).toEqual([])
    expect(await query("select pgmq_public.send('receipt_test', '{\"preserved\":true}'::jsonb) as id"))
      .toEqual([{ id: '9007199254740996' }])
    await query('reset role')

    const snapshot = async () => ({
      queue: await query('select msg_id::text, read_ct, vt, message from pgmq.q_receipt_test order by msg_id'),
      archive: await query('select msg_id::text, read_ct, message from pgmq.a_receipt_test order by msg_id'),
      sequence: await query('select last_value::text, is_called from pgmq.q_receipt_test_msg_id_seq'),
    })
    const before = await snapshot()
    const invalid: Array<{ sql: string; code: string }> = [
      { sql: "select pgmq_public.send('Receipt_test', '{}'::jsonb)", code: '22023' },
      { sql: "select pgmq_public.send(' receipt_test ', '{}'::jsonb)", code: '22023' },
      { sql: "select pgmq_public.send('supacloud_internal_test', '{}'::jsonb)", code: '42501' },
      { sql: "select pgmq_public.send('receipt_test', null)", code: '22023' },
      { sql: "select pgmq_public.send('receipt_test', '{}'::jsonb, -1)", code: '22023' },
      { sql: "select pgmq_public.send_batch('receipt_test', array['{}'::jsonb, null])", code: '22023' },
      { sql: "select pgmq_public.read('receipt_test', null, 1)", code: '22023' },
      { sql: "select pgmq_public.read('receipt_test', 0, 10001)", code: '22023' },
      { sql: "select pgmq_public.archive('receipt_test', 0)", code: '22023' },
      { sql: "select pgmq_public.delete('receipt_test', -1)", code: '22023' },
      {
        sql: "select pgmq_public.send('receipt_test', to_jsonb(repeat('x', 1048576)))",
        code: '22023',
      },
      {
        sql: "select pgmq_public.send('receipt_test', (select jsonb_agg(n) from generate_series(1, 10000) n))",
        code: '22023',
      },
    ]
    for (const { sql, code } of invalid) {
      await query('set role anon')
      try {
        await expect(query(sql)).rejects.toMatchObject({ code })
      } finally {
        await query('reset role')
      }
      expect(await snapshot()).toEqual(before)
    }
  } finally {
    await backend.close()
  }
}, 60_000)

test('Lite reopens persisted legacy queue RPCs without losing messages or bigint identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-lite-queue-upgrade-'))
  const config = { dataDir: join(directory, 'db'), startRuntimeServices: false }
  const snapshot = async (backend: Awaited<ReturnType<typeof createBackend>>) => ({
    queue: (await backend.db.query<Record<string, unknown>>(
      'select msg_id::text, read_ct, enqueued_at, vt, message from pgmq.q_upgrade_test order by msg_id',
    )).rows,
    archive: (await backend.db.query<Record<string, unknown>>(
      'select msg_id::text, read_ct, enqueued_at, archived_at, vt, message from pgmq.a_upgrade_test order by msg_id',
    )).rows,
    sequence: (await backend.db.query<Record<string, unknown>>(
      'select last_value::text, is_called from pgmq.q_upgrade_test_msg_id_seq',
    )).rows,
  })
  try {
    const initial = await createBackend(config)
    let before: Awaited<ReturnType<typeof snapshot>>
    try {
      await initial.db.engine.exec(`
        DROP FUNCTION pgmq_public.send(text,jsonb,integer);
        DROP FUNCTION pgmq_public.send_batch(text,jsonb[],integer);
        DROP FUNCTION pgmq_public.read(text,integer,integer);
        DROP FUNCTION pgmq_public.pop(text);
        CREATE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
        RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = ''
        AS $$ SELECT * FROM pgmq.send(queue_name, message, sleep_seconds) $$;
        CREATE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
        RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = ''
        AS $$ SELECT * FROM pgmq.send_batch(queue_name, messages, sleep_seconds) $$;
        CREATE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
        RETURNS SETOF pgmq.message_record LANGUAGE sql SECURITY DEFINER SET search_path = ''
        AS $$ SELECT * FROM pgmq.read(queue_name, sleep_seconds, n) $$;
        CREATE FUNCTION pgmq_public.pop(queue_name text)
        RETURNS SETOF pgmq.message_record LANGUAGE sql SECURITY DEFINER SET search_path = ''
        AS $$ SELECT * FROM pgmq.pop(queue_name) $$;
        SELECT pgmq.create('upgrade_test');
        ALTER TABLE pgmq.q_upgrade_test ALTER COLUMN msg_id RESTART WITH 9007199254740993;
        SELECT pgmq_public.send_batch('upgrade_test', ARRAY['{"kept":true}'::jsonb, '"archived"'::jsonb]);
        SELECT pgmq.archive('upgrade_test', 9007199254740994);
      `)
      expect((await initial.db.query<Record<string, unknown>>(`
        SELECT proname, prorettype::regtype::text AS result
        FROM pg_proc WHERE pronamespace = 'pgmq_public'::regnamespace
          AND proname IN ('send', 'send_batch', 'read', 'pop') ORDER BY proname
      `)).rows).toEqual([
        { proname: 'pop', result: 'pgmq.message_record' },
        { proname: 'read', result: 'pgmq.message_record' },
        { proname: 'send', result: 'bigint' },
        { proname: 'send_batch', result: 'bigint' },
      ])
      before = await snapshot(initial)
    } finally {
      await initial.close()
    }

    for (let reopening = 0; reopening < 2; reopening += 1) {
      const backend = await createBackend(config)
      try {
        expect(await snapshot(backend)).toEqual(before)
        expect((await backend.db.query<Record<string, unknown>>(`
          SELECT proname, prorettype::regtype::text AS result
          FROM pg_proc WHERE pronamespace = 'pgmq_public'::regnamespace
            AND proname IN ('send', 'send_batch', 'read', 'pop') ORDER BY proname
        `)).rows).toEqual([
          { proname: 'pop', result: 'record' },
          { proname: 'read', result: 'record' },
          { proname: 'send', result: 'text' },
          { proname: 'send_batch', result: 'text' },
        ])
        if (reopening === 0) continue
        await backend.db.query<unknown>('set role anon')
        expect((await backend.db.query<Record<string, unknown>>(
          "select * from pgmq_public.read('upgrade_test', 0, 1)",
        )).rows).toMatchObject([{
          msg_id: '9007199254740993', read_ct: 1, message: { kept: true },
          last_read_at: null, headers: null,
        }])
        expect((await backend.db.query<Record<string, unknown>>(
          "select pgmq_public.send('upgrade_test', 'null'::jsonb) as id",
        )).rows).toEqual([{ id: '9007199254740995' }])
        expect((await backend.db.query<Record<string, unknown>>(
          "select pgmq_public.send_batch('upgrade_test', array['true'::jsonb]) as id",
        )).rows).toEqual([{ id: '9007199254740996' }])
        expect((await backend.db.query<Record<string, unknown>>(
          "select * from pgmq_public.pop('upgrade_test')",
        )).rows).toMatchObject([{ msg_id: '9007199254740993', message: { kept: true } }])
      } finally {
        await backend.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test('Lite HTTP queue receipts round-trip through the official client and workspace SDK', async () => {
  const backend = await createBackend({
    startRuntimeServices: false,
    jwtSecret: 'queue-http-fixture-secret'.repeat(3),
    vaultKey: 'v'.repeat(64),
    log: () => {},
  })
  try {
    await backend.db.query<unknown>("select pgmq.create('http_receipts')")
    await backend.db.query<unknown>(
      'alter table pgmq.q_http_receipts alter column msg_id restart with 9007199254740993',
    )
    const calls: Array<{ path: string; status: number; body: unknown }> = []
    const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (!path.startsWith('/rest/v1/rpc/')) throw new Error('Unexpected non-RPC request')
      const response = await backend.fetch(request)
      const body: unknown = await response.clone().json()
      calls.push({ path, status: response.status, body })
      return response
    }, { preconnect: globalThis.fetch.preconnect })
    const supabase = createClient('http://local', backend.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
    })
    const sdk = createSupaCloudClient({
      supabase, managementApiUrl: 'http://management-not-used', projectRef: 'lite',
    })
    await backend.db.query<unknown>(`
      create function public.queue_encoding_probe(j json, js json[], nums integer[])
      returns jsonb language sql as $$
        select jsonb_build_object('j', j, 'js', js, 'nums', nums)
      $$
    `)
    const encoded = await supabase.rpc('queue_encoding_probe', {
      j: 'text', js: ['quoted"\\value', null, [1, 2]], nums: [1, 2],
    })
    expect(encoded.error).toBeNull()
    expect(encoded.data).toEqual({ j: 'text', js: ['quoted"\\value', null, [1, 2]], nums: [1, 2] })
    const getEncoded = await supabase.rpc('queue_encoding_probe', {
      j: '"text"', js: '{"null"}', nums: '{1,2}',
    }, { get: true })
    expect(getEncoded.error).toBeNull()
    expect(getEncoded.data).toEqual({ j: 'text', js: [null], nums: [1, 2] })
    calls.length = 0
    const queue = sdk.queue('http_receipts')
    const first = await queue.send({ nested: [null, true, 'text'] })
    expect(first.msg_id).toBe('9007199254740993')
    expect(calls[0]).toEqual({
      path: '/rest/v1/rpc/send', status: 200, body: ['9007199254740993'],
    })
    expect((await queue.sendBatch(['plain', [null, false], null])).map(item => item.msg_id))
      .toEqual(['9007199254740994', '9007199254740995', '9007199254740996'])
    expect(await queue.read({ count: 1, sleep_seconds: 60 })).toMatchObject([{
      msg_id: first.msg_id, payload: { nested: [null, true, 'text'] },
    }])
    expect(calls.find(call => call.path.endsWith('/read'))?.body).toMatchObject([{
      msg_id: first.msg_id, last_read_at: null, headers: null,
    }])
    expect((await queue.archive(first.msg_id)).success).toBe(true)
    expect((await queue.archive(first.msg_id)).success).toBe(false)
    expect(await queue.pop()).toMatchObject({ msg_id: '9007199254740994', payload: 'plain' })
    expect((await queue.delete('9007199254740995')).success).toBe(true)
    expect((await queue.delete('9007199254740995')).success).toBe(false)
    expect(await queue.pop()).toMatchObject({ msg_id: '9007199254740996', payload: null })
    for (const payload of ['"quoted"\\text', null, false, 42, [true, null]]) {
      const sent = await queue.send(payload)
      expect(await queue.pop()).toMatchObject({ msg_id: sent.msg_id, payload })
    }
    expect(await queue.receive()).toBeNull()
    expect(await queue.pop()).toBeNull()

    const protectedMessage = await queue.send({ preserved: true })
    const snapshot = async () => ({
      rows: (await backend.db.query<Record<string, unknown>>(
        'select msg_id::text, message, read_ct, vt from pgmq.q_http_receipts order by msg_id',
      )).rows,
      sequence: (await backend.db.query<Record<string, unknown>>(
        'select last_value::text, is_called from pgmq.q_http_receipts_msg_id_seq',
      )).rows,
    })
    const before = await snapshot()
    for (const value of [-1, null, 0.5, true]) {
      const response = await backend.fetch(new Request('http://local/rest/v1/rpc/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${backend.anonKey}`,
          'content-type': 'application/json',
          'content-profile': 'pgmq_public',
        },
        body: JSON.stringify({ queue_name: 'http_receipts', message: {}, sleep_seconds: value }),
      }))
      expect(response.status).toBe(400)
      expect(await snapshot()).toEqual(before)
    }
    expect((await queue.receive())?.msg_id).toBe(protectedMessage.msg_id)
  } finally {
    await backend.close()
  }
}, 60_000)

test('Lite refuses a persisted queue return-type upgrade with dependent user SQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-lite-queue-dependent-'))
  const dataDir = join(directory, 'db')
  const config = { dataDir, startRuntimeServices: false }
  const catalogSql = `
    SELECT proname, prorettype::regtype::text AS result, prosrc, proacl::text
    FROM pg_proc WHERE pronamespace = 'pgmq_public'::regnamespace ORDER BY proname
  `
  try {
    const initial = await createBackend(config)
    let before: Array<Record<string, unknown>>
    try {
      await initial.db.engine.exec(`
        DROP FUNCTION pgmq_public.send(text,jsonb,integer);
        CREATE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
        RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = ''
        AS $$ SELECT * FROM pgmq.send(queue_name, message, sleep_seconds) $$;
        CREATE VIEW public.queue_user_dependency AS
          SELECT * FROM pgmq_public.send('dependency_test', '{}'::jsonb);
        SELECT pgmq.create('dependency_test');
        SELECT pgmq.send('dependency_test', '{"preserved":true}'::jsonb);
      `)
      before = (await initial.db.query<Record<string, unknown>>(catalogSql)).rows
    } finally {
      await initial.close()
    }
    // Do not evaluate the dependent view: it deliberately wraps a mutating RPC.
    await expect(createBackend(config)).rejects.toMatchObject({ code: '2BP01' })
    const engine = await createPgliteEngine(dataDir)
    try {
      expect((await engine.query<Record<string, unknown>>(catalogSql)).rows).toEqual(before)
      expect((await engine.query<Record<string, unknown>>(
        "select to_regclass('public.queue_user_dependency')::text as name",
      )).rows).toEqual([{ name: 'queue_user_dependency' }])
      expect((await engine.query<Record<string, unknown>>(
        'select msg_id::text, read_ct, message from pgmq.q_dependency_test',
      )).rows).toEqual([{ msg_id: '1', read_ct: 0, message: { preserved: true } }])
      await engine.exec('drop view public.queue_user_dependency')
    } finally {
      await engine.close()
    }
    const recovered = await createBackend(config)
    try {
      expect((await recovered.db.query<Record<string, unknown>>(
        "select pgmq_public.send('dependency_test', 'true'::jsonb) as id",
      )).rows).toEqual([{ id: '2' }])
    } finally {
      await recovered.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
