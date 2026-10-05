import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../src/runtime/index.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'
import { computeDbDiff, pullSchema } from '../src/runtime/node/db-diff.js'
import { snapshotSchema, diffSchemas } from '../src/runtime/db/schema-diff.js'

test('catalog drift rejects RLS, grants and non-append enum changes without emitting partial SQL', async () => {
  const backend = await createBackend({ startRuntimeServices: false, migrations: [{
    name: '20260101000000_initial',
    sql: "create table public.items(id int); create type public.phase as enum ('one','two');",
  }] })
  try {
    const before = await snapshotSchema(backend.db)
    await backend.db.exec('alter table public.items enable row level security')
    const enabled = await snapshotSchema(backend.db)
    expect(() => diffSchemas(before, enabled)).toThrow('catalog attributes')
    await backend.db.exec('alter table public.items disable row level security; revoke select on public.items from anon')
    const revoked = await snapshotSchema(backend.db)
    expect(() => diffSchemas(before, revoked)).toThrow('catalog attributes')
    const reordered = { ...before, enums: new Map([['phase', ['two', 'one']]]) }
    expect(() => diffSchemas(before, reordered)).toThrow('appending enum')
  } finally { await backend.close() }
}, 30000)

test('schema authoring inspects without bootstrap or applying pending migrations and baselines only explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schema-authoring-'))
  const dataDir = join(root, 'db')
  const first = { name: '20260101000000_initial', sql: 'create table public.items (id int primary key);' }
  try {
    const backend = await createBackend({ dataDir, migrations: [first], startRuntimeServices: false })
    await backend.db.query('alter table public.items add column title text')
    await backend.close()
    const ddl = await computeDbDiff({ liveDataDir: dataDir, migrations: [first] })
    expect(ddl.join('\n')).toContain('add column "title" text')
    const draft = await pullSchema({
      liveDataDir: dataDir, migrations: [first], migrationsDir: join(root, 'drafts'),
      stamp: '20260102000000', name: 'title',
    })
    expect(await readFile(draft.path!, 'utf8')).toContain('add column "title" text')
    const inspect = await createPgliteEngine(dataDir, { inspectOnly: true })
    expect((await inspect.query<{ count: number }>('select count(*)::int as count from supabase_migrations.schema_migrations')).rows[0]?.count).toBe(1)
    await inspect.close()
    await expect(computeDbDiff({ liveDataDir: dataDir, migrations: [
      first, { name: '20260103000000_pending', sql: 'create table public.pending(id int);' },
    ] })).rejects.toThrow('matching applied migration history')
    const baseline = await pullSchema({
      liveDataDir: dataDir, migrations: [first], migrationsDir: join(root, 'migrations'),
      baseline: true, stamp: '20260102000000', name: 'title',
    })
    const sql = await readFile(baseline.path!, 'utf8')
    const restarted = await createBackend({
      dataDir, startRuntimeServices: false,
      migrations: [first, { name: '20260102000000_title', sql }],
    })
    expect((await restarted.db.listAppliedMigrations()).length).toBe(2)
    await restarted.close()
    expect(await computeDbDiff({ liveDataDir: dataDir, migrations: [first, { name: '20260102000000_title', sql }] })).toEqual([])
    const changed = await createPgliteEngine(dataDir, { inspectOnly: true })
    await changed.exec('create view public.item_names as select title from public.items')
    await changed.close()
    await expect(computeDbDiff({ liveDataDir: dataDir, migrations: [first, { name: '20260102000000_title', sql }] }))
      .rejects.toThrow('pg-delta')
    await expect(pullSchema({ migrations: [], name: '../escape', stamp: 'bad' })).rejects.toThrow('Invalid migration')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120000)
