import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'
import type { RequestContext } from '../src/runtime/types.js'
import { testTimeout } from './helpers/timeouts.js'

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('REST role-aware count estimates', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.estimate_items (id integer primary key, owner_id uuid not null);
      insert into public.estimate_items
        select id, case when id <= 4 then '${ownerId}'::uuid else '${otherId}'::uuid end
        from generate_series(1, 120) id;
      alter table public.estimate_items enable row level security;
      create policy anonymous_read on public.estimate_items for select to anon using (id <= 2);
      create policy owner_read on public.estimate_items for select to authenticated using (owner_id = auth.uid());
      create table public.estimate_init_items (like public.estimate_items including all);
      insert into public.estimate_init_items select * from public.estimate_items;
      alter table public.estimate_init_items enable row level security;
      create policy owner_read on public.estimate_init_items for select to authenticated
        using (owner_id = (select auth.uid()));
      create table public.estimate_links (id integer primary key, item_id integer references public.estimate_items);
      insert into public.estimate_links values (1, 1), (2, 1), (3, 2), (4, 3), (5, 4);
      create view public.estimate_view with (security_invoker = true) as
        select * from public.estimate_items where id <= 4;
      create view public.estimate_groups with (security_invoker = true) as
        select owner_id, count(*) as items from public.estimate_items group by owner_id;
      create table public.estimate_denied (id integer primary key);
      insert into public.estimate_denied select generate_series(1, 40);
      alter table public.estimate_denied enable row level security;
      analyze public.estimate_items;
      analyze public.estimate_init_items;
      analyze public.estimate_links;
      analyze public.estimate_denied;
    `)
    rest = new RestHandler(db)
  }, testTimeout(60_000))

  afterAll(async () => {
    await db?.close()
  })

  function read(path: string, options: {
    count: 'exact' | 'planned' | 'estimated'
    method?: 'GET' | 'HEAD'
    role?: RequestContext['role']
    subject?: string
    handler?: RestHandler
    range?: string
  }) {
    const role = options.role ?? 'service_role'
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    const headers = new Headers({ prefer: `count=${options.count}` })
    if (options.range) headers.set('range', options.range)
    return (options.handler ?? rest).handle(new Request(url, {
      method: options.method ?? 'GET', headers,
    }), { role, claims: { role, sub: options.subject ?? ownerId } }, url)
  }

  function total(response: Response): number {
    expect([200, 206]).toContain(response.status)
    const range = response.headers.get('content-range')
    expect(range).toMatch(/^(?:\*|\d+-\d+)\/\d+$/)
    return Number(range!.split('/')[1])
  }

  for (const method of ['GET', 'HEAD'] as const) {
    for (const [role, visible] of [['anon', 2], ['authenticated', 4]] as const) {
      test(`${method} estimates respect ${role} RLS after ANALYZE`, async () => {
        const exact = await read('estimate_items?order=id', { count: 'exact', method, role })
        expect(total(exact)).toBe(visible)
        const planned = await read('estimate_items?order=id', { count: 'planned', method, role })
        const estimated = await read('estimate_items?order=id', { count: 'estimated', method, role })
        expect(total(estimated)).toBe(total(planned))
        expect(total(estimated)).toBeLessThan(120)
        if (method === 'HEAD') expect(await estimated.text()).toBe('')
        else expect((await estimated.json() as unknown[]).length).toBe(visible)
      })
    }
  }

  test('keeps authenticated estimates bound to each request subject', async () => {
    for (const subject of [ownerId, otherId]) {
      const planned = await read('estimate_items', { count: 'planned', role: 'authenticated', subject })
      const estimated = await read('estimate_items', { count: 'estimated', role: 'authenticated', subject })
      expect(total(estimated)).toBe(total(planned))
      expect(total(estimated)).toBeLessThan(120)
    }
  })

  test('reads the aggregate input rather than an RLS InitPlan', async () => {
    const role = 'authenticated'
    const ctx = { role, claims: { role, sub: ownerId } } as const
    const plan = await db!.withContext(ctx, async (query) => {
      await query('set transaction read only')
      return query<{ 'QUERY PLAN': { Plan: { 'Plan Rows': number } }[] }>(
        'explain (format json) select 1 from public.estimate_init_items',
      )
    })
    const expected = plan.rows[0]!['QUERY PLAN'][0]!.Plan['Plan Rows']
    expect(expected).toBeGreaterThan(1)
    for (const count of ['planned', 'estimated'] as const) {
      const response = await read('estimate_init_items', { count, role })
      expect(total(response)).toBe(expected)
      expect((await response.json() as unknown[]).length).toBe(4)
    }
  })

  test('disables parallel workers while planning a count', async () => {
    const database = db!
    const previous = await database.query<{ workers: string }>(
      "select current_setting('max_parallel_workers_per_gather') as workers",
    )
    await database.exec('set max_parallel_workers_per_gather = 2')
    const observedWorkers: string[] = []
    const originalWithContext = database.withContext.bind(database)
    database.withContext = ((ctx, callback) => originalWithContext(ctx, (query) => callback(async (sql, params) => {
      if (sql.startsWith('explain (format json) ')) {
        const settings = await query<{ workers: string }>(
          "select current_setting('max_parallel_workers_per_gather') as workers",
        )
        observedWorkers.push(settings.rows[0]!.workers)
      }
      return query(sql, params)
    }))) as typeof database.withContext
    try {
      for (const count of ['planned', 'estimated'] as const) {
        for (const role of ['anon', 'authenticated'] as const) {
          const response = await read('estimate_items', { count, role })
          expect(total(response)).toBeGreaterThan(0)
          const session = await database.query<{ workers: string }>(
            "select current_setting('max_parallel_workers_per_gather') as workers",
          )
          expect(session.rows[0]!.workers).toBe('2')
        }
      }
      expect(observedWorkers).toEqual(['0', '0', '0', '0'])
    } finally {
      database.withContext = originalWithContext
      await database.query("select set_config('max_parallel_workers_per_gather', $1, false)", [
        previous.rows[0]!.workers,
      ])
    }
  })

  for (const role of ['anon', 'authenticated'] as const) {
    test(`does not expose table statistics when ${role} has no SELECT policy`, async () => {
      const response = await read('estimate_denied', { count: 'estimated', role })
      expect(total(response)).toBe(0)
      expect(await response.json()).toEqual([])
    })
  }

  const shapes = [
    ['base filter', 'estimate_items?id=lte.4', 4],
    ['logical filter', 'estimate_items?or=(id.eq.1,id.eq.2)', 2],
    ['inner embed', 'estimate_items?select=id,estimate_links!inner(id)', 4],
    ['filtered inner embed', 'estimate_items?select=id,estimate_links!inner(id)&estimate_links.id=gt.3', 2],
    ['security-invoker view', 'estimate_view', 4],
    ['grouped view', 'estimate_groups', 2],
    ['grouped selection', 'estimate_items?select=owner_id,id.count()', 2],
    ['ungrouped aggregate', 'estimate_items?select=count()', 1],
  ] as const

  for (const [shape, path, expected] of shapes) {
    test(`estimates the query-derived row set for a ${shape}`, async () => {
      const exact = await read(path, { count: 'exact' })
      expect(total(exact)).toBe(expected)
      const planned = await read(path, { count: 'planned' })
      const estimated = await read(path, { count: 'estimated' })
      expect(total(estimated)).toBe(total(planned))
      expect(total(estimated)).toBe(expected)
    })
  }

  test('keeps pagination and maxRows out of the estimated total', async () => {
    const handler = new RestHandler(db!, { maxRows: 2 })
    const response = await read('estimate_items?order=id', {
      count: 'estimated', range: '2-5', handler,
    })
    expect(total(response)).toBe(120)
    expect(response.headers.get('content-range')).toBe('2-3/120')
    expect(await response.json()).toEqual([{ id: 3, owner_id: ownerId }, { id: 4, owner_id: ownerId }])
  })
})
