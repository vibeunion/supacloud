import { sdkObservation, type ParityObservation, type ParityScenario } from './contract.js'

const errorScenario = (
  name: string,
  code: string,
  run: ParityScenario['run']
): ParityScenario => ({
  name,
  module: 'protocol',
  run,
  expect: (observation) => !observation.ok && observation.code === code,
})

export const PARITY_SCENARIOS: ParityScenario[] = [
  {
    name: 'range and content-range headers',
    module: 'protocol',
    run: async ({ request }) => {
      const response = await request('/rest/v1/posts?select=id,title&order=id.asc', {
        headers: { range: '0-0', 'range-unit': 'items', prefer: 'count=exact' },
      })
      return {
        ok: response.ok,
        status: response.status,
        data: { contentRange: response.headers.get('content-range'), rows: (await response.json() as unknown[]).length },
      }
    },
    expect: (observation) => observation.ok &&
      (observation.status === 200 || observation.status === 206) &&
      (observation.data as { contentRange?: string; rows?: number })?.rows === 1 &&
      /^0-0\/\d+$/.test((observation.data as { contentRange?: string })?.contentRange ?? ''),
  },
  {
    name: 'filter and relation embed',
    module: 'rest',
    run: async ({ anon }) => sdkObservation(
      await anon.from('posts').select('title,authors(name)').eq('published', true).gt('views', 10).single()
    ),
    expect: (observation) => observation.ok &&
      (observation.data as { title?: string; authors?: { name?: string } })?.authors?.name === 'Ada',
  },
  {
    name: 'rpc scalar result',
    module: 'rpc',
    run: async ({ anon }) => sdkObservation(await anon.rpc('parity_add_two', { left_value: 40, right_value: 2 })),
    expect: (observation) => observation.ok && observation.data === 42,
  },
  errorScenario('unique violation', '23505', async ({ service, runId }) => {
    const email = `duplicate-${runId}@example.com`
    await service.from('authors').insert({ name: 'first', email })
    return sdkObservation(await service.from('authors').insert({ name: 'second', email }))
  }),
  errorScenario('foreign key violation', '23503', async ({ service, runId }) => sdkObservation(
    await service.from('posts').insert({ title: `fk-${runId}`, author_id: 2_147_483_647 })
  )),
  errorScenario('check violation', '23514', async ({ service, runId }) => sdkObservation(
    await service.from('posts').insert({ title: `check-${runId}`, views: -1 })
  )),
  errorScenario('invalid input syntax', '22P02', async ({ anon }) => sdkObservation(
    await anon.from('posts').select('id').eq('id', 'not-an-integer')
  )),
  errorScenario('single row missing', 'PGRST116', async ({ anon }) => sdkObservation(
    await anon.from('posts').select('id').eq('id', 2_147_483_647).single()
  )),
  errorScenario('missing rpc', 'PGRST202', async ({ anon }) => sdkObservation(
    await anon.rpc('parity_missing_function')
  )),
  errorScenario('missing mutation column', 'PGRST204', async ({ service }) => sdkObservation(
    await service.from('authors').insert({ missing_column: 'value' } as never)
  )),
  errorScenario('unexposed schema', 'PGRST106', async ({ anon }) => sdkObservation(
    await anon.schema('auth').from('users').select('id')
  )),
  {
    name: 'signup returns a usable session',
    module: 'auth',
    run: async ({ anon, runId }) => {
      const response = await anon.auth.signUp({ email: `session-${runId}@example.com`, password: 'password123' })
      return {
        ok: !response.error,
        ...(response.error?.status ? { status: response.error.status } : {}),
        data: { hasToken: Boolean(response.data.session?.access_token), hasUser: Boolean(response.data.user?.id) },
      }
    },
    expect: (observation) => observation.ok &&
      (observation.data as { hasToken?: boolean; hasUser?: boolean })?.hasToken === true &&
      (observation.data as { hasToken?: boolean; hasUser?: boolean })?.hasUser === true,
  },
  {
    name: 'RLS isolates rows between users',
    module: 'rls',
    run: async ({ anon, service, runId }) => {
      await anon.auth.signUp({ email: `owner-${runId}@example.com`, password: 'password123' })
      const inserted = await anon.from('notes').insert({ content: `secret-${runId}` })
      await anon.auth.signOut()
      await anon.auth.signUp({ email: `other-${runId}@example.com`, password: 'password123' })
      const otherRows = await anon.from('notes').select('content').eq('content', `secret-${runId}`)
      const serviceRows = await service.from('notes').select('content').eq('content', `secret-${runId}`)
      return {
        ok: !inserted.error && !otherRows.error && !serviceRows.error,
        data: { otherCount: otherRows.data?.length ?? -1, serviceCount: serviceRows.data?.length ?? -1 },
      }
    },
    expect: (observation) => observation.ok &&
      (observation.data as { otherCount?: number; serviceCount?: number })?.otherCount === 0 &&
      (observation.data as { otherCount?: number; serviceCount?: number })?.serviceCount === 1,
  },
  {
    name: 'storage lifecycle',
    module: 'storage',
    run: async ({ service, runId }) => {
      const bucket = `parity-${runId}`
      const created = await service.storage.createBucket(bucket, { public: true })
      const uploaded = await service.storage.from(bucket).upload('hello.txt', new Blob(['hello'], { type: 'text/plain' }))
      const downloaded = await service.storage.from(bucket).download('hello.txt')
      const removed = await service.storage.from(bucket).remove(['hello.txt'])
      return {
        ok: !created.error && !uploaded.error && !downloaded.error && !removed.error,
        data: { body: downloaded.data ? await downloaded.data.text() : null, removed: removed.data?.length ?? 0 },
      }
    },
    expect: (observation) => observation.ok &&
      (observation.data as { body?: string; removed?: number })?.body === 'hello' &&
      (observation.data as { body?: string; removed?: number })?.removed === 1,
  },
]

export function failureObservation(error: unknown): ParityObservation {
  return { ok: false, data: { threw: error instanceof Error ? error.message : String(error) } }
}
