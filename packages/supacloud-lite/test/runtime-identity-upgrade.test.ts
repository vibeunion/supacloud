import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOTSTRAP_SQL } from '../src/runtime/db/bootstrap.js'
import { Database, type CdcEvent } from '../src/runtime/db/database.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

const LEGACY_PREFIX = ['tin', 'base'].join('')
const LEGACY_CDC_CHANNEL = `${LEGACY_PREFIX}_cdc`
const RUNTIME_EVENTS_TABLE_SQL = `
create table public.runtime_upgrade_events (id integer primary key, label text not null);
`
const LEGACY_CDC_FUNCTION_SQL = `
create or replace function ${LEGACY_PREFIX}.cdc_notify() returns trigger
language plpgsql security definer as $$
begin
  perform pg_notify(
    '${LEGACY_CDC_CHANNEL}',
    json_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'type', TG_OP,
      'commit_timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'record', row_to_json(NEW),
      'old_record', null
    )::text
  );
  return NEW;
end $$;
`
const LEGACY_CDC_TRIGGER_SQL = `
create trigger ${LEGACY_PREFIX}_cdc
  after insert or update or delete on public.runtime_upgrade_events
  for each row execute function ${LEGACY_PREFIX}.cdc_notify();
`
const LEGACY_POLICIES_SQL = `
create policy ${LEGACY_PREFIX}_authenticated_all on storage.objects
  for all to authenticated using (true) with check (true);
create policy ${LEGACY_PREFIX}_public_read on storage.objects
  for select to anon using (true);
`
const LEGACY_ONLY_CATALOG_SQL = `
alter schema supacloud_lite rename to ${LEGACY_PREFIX};
${LEGACY_CDC_FUNCTION_SQL}
${RUNTIME_EVENTS_TABLE_SQL}
${LEGACY_CDC_TRIGGER_SQL}
${LEGACY_POLICIES_SQL}
`
const COEXISTING_CATALOG_SQL = `
${RUNTIME_EVENTS_TABLE_SQL}
create trigger supacloud_lite_cdc
  after insert or update or delete on public.runtime_upgrade_events
  for each row execute function supacloud_lite.cdc_notify();
create schema ${LEGACY_PREFIX};
${LEGACY_CDC_FUNCTION_SQL}
${LEGACY_CDC_TRIGGER_SQL}
${LEGACY_POLICIES_SQL}
`

interface RuntimeIdentityCounts {
  legacy_schema_count: number
  current_schema_count: number
  legacy_function_count: number
  current_function_count: number
  legacy_trigger_count: number
  current_trigger_count: number
  permissive_policy_count: number
}

const RUNTIME_IDENTITY_COUNTS_SQL = `
select
  (select count(*)::int from pg_namespace where nspname = '${LEGACY_PREFIX}') as legacy_schema_count,
  (select count(*)::int from pg_namespace where nspname = 'supacloud_lite') as current_schema_count,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '${LEGACY_PREFIX}' and p.proname = 'cdc_notify') as legacy_function_count,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'supacloud_lite' and p.proname = 'cdc_notify') as current_function_count,
  (select count(*)::int from pg_trigger where tgname = '${LEGACY_PREFIX}_cdc') as legacy_trigger_count,
  (select count(*)::int from pg_trigger where tgname = 'supacloud_lite_cdc') as current_trigger_count,
  (select count(*)::int from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        '${LEGACY_PREFIX}_authenticated_all',
        '${LEGACY_PREFIX}_public_read',
        'supacloud_lite_authenticated_all',
        'supacloud_lite_public_read'
      )) as permissive_policy_count
`

test('upgrades legacy-only runtime identities without duplicate CDC events', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-legacy-runtime-'))
  let database: Database | undefined
  try {
    const dataDir = join(rootDir, 'db')
    await seedRuntimeCatalog(dataDir, LEGACY_ONLY_CATALOG_SQL)
    database = await Database.create(dataDir)
    await expectCurrentRuntimeIdentities(database)
    await expectSingleCdcEvent(database, 1, 'legacy-only')
  } finally {
    await database?.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}, 30_000)

test('deduplicates coexisting runtime identities without duplicate CDC events', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-coexisting-runtime-'))
  let database: Database | undefined
  try {
    const dataDir = join(rootDir, 'db')
    await seedRuntimeCatalog(dataDir, COEXISTING_CATALOG_SQL)
    database = await Database.create(dataDir)
    await expectCurrentRuntimeIdentities(database)
    await expectSingleCdcEvent(database, 1, 'coexisting')
  } finally {
    await database?.close()
    await rm(rootDir, { recursive: true, force: true })
  }
}, 30_000)

async function seedRuntimeCatalog(dataDir: string, catalogSql: string): Promise<void> {
  const engine = await createPgliteEngine(dataDir)
  try {
    await engine.exec(BOOTSTRAP_SQL)
    await engine.exec(catalogSql)
  } finally {
    await engine.close()
  }
}

async function expectCurrentRuntimeIdentities(database: Database): Promise<void> {
  const identityCounts = await database.query<RuntimeIdentityCounts>(RUNTIME_IDENTITY_COUNTS_SQL)
  expect(identityCounts.rows[0]).toEqual({
    legacy_schema_count: 0,
    current_schema_count: 1,
    legacy_function_count: 0,
    current_function_count: 1,
    legacy_trigger_count: 0,
    current_trigger_count: 1,
    permissive_policy_count: 0,
  })
}

async function expectSingleCdcEvent(database: Database, id: number, label: string): Promise<void> {
  const cdcEvents: CdcEvent[] = []
  const stopCdc = await database.onCdcEvent((cdcEvent) => cdcEvents.push(cdcEvent))
  try {
    await database.exec(`insert into public.runtime_upgrade_events (id, label) values (${id}, '${label}')`)
    await Bun.sleep(50)
  } finally {
    await stopCdc()
  }
  expect(cdcEvents).toHaveLength(1)
  expect(cdcEvents[0]).toMatchObject({
    schema: 'public',
    table: 'runtime_upgrade_events',
    type: 'INSERT',
    record: { id, label },
  })
}
