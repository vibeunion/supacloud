import { PGlite } from '@electric-sql/pglite'
import { createBackend } from '../../src/runtime/index.js'
import { Database } from '../../src/runtime/db/database.js'
import { createPgliteEngine } from '../../src/runtime/db/pglite-engine.js'

interface TimezoneRow {
  session_timezone: string
  observed_at: string
}

const TIMESTAMP_PROBE_SQL = `
  select current_setting('TimeZone') as session_timezone,
         to_json('2026-08-10T00:00:00Z'::timestamptz) as observed_at
`
const TIMEZONE_PROBE_MIGRATION = {
  name: '20260811000000_timezone_probe.sql',
  sql: `
    create table public.timezone_probes (observed_at timestamptz not null);
    insert into public.timezone_probes values ('2026-08-10T00:00:00Z');
    create function public.timezone_probe() returns timestamptz
      language sql stable as $$ select '2026-08-10T00:00:00Z'::timestamptz $$;
    grant select on public.timezone_probes to service_role;
    grant execute on function public.timezone_probe() to service_role;
  `,
} as const
const dataDir = process.env.SUPACLOUD_LITE_TIMEZONE_DATA_DIR
const probeMode = process.env.SUPACLOUD_LITE_TIMEZONE_PROBE_MODE

if (!dataDir) throw new Error('SUPACLOUD_LITE_TIMEZONE_DATA_DIR is required')

switch (probeMode) {
  case 'create-legacy':
    await probeLegacyDatabase(dataDir)
    break
  case 'minimal':
    await probeMinimalDatabase(dataDir)
    break
  case 'set-custom-timezone':
    await setCustomDatabaseTimezone(dataDir)
    break
  case 'full':
    await probeFullDataApi(dataDir)
    break
  default:
    throw new Error(`unsupported timezone probe mode: ${probeMode ?? '<missing>'}`)
}

async function probeLegacyDatabase(probeDataDir: string): Promise<void> {
  const pg = new PGlite({ dataDir: probeDataDir })
  await pg.waitReady
  try {
    emitEngineProbe((await pg.query<TimezoneRow>(TIMESTAMP_PROBE_SQL)).rows[0])
  } finally {
    await pg.close()
  }
}

async function probeMinimalDatabase(probeDataDir: string): Promise<void> {
  const engine = await createPgliteEngine(probeDataDir)
  engine.minimalBootstrap = true
  const database = await Database.create(engine)
  try {
    emitEngineProbe((await database.query<TimezoneRow>(TIMESTAMP_PROBE_SQL)).rows[0])
  } finally {
    await database.close()
  }
}

async function setCustomDatabaseTimezone(probeDataDir: string): Promise<void> {
  const engine = await createPgliteEngine(probeDataDir)
  try {
    await engine.exec(`alter database postgres set timezone to 'Asia/Shanghai'`)
    emitEngineProbe((await engine.query<TimezoneRow>(TIMESTAMP_PROBE_SQL)).rows[0])
  } finally {
    await engine.close()
  }
}

async function probeFullDataApi(probeDataDir: string): Promise<void> {
  const backend = await createBackend({
    dataDir: probeDataDir,
    log: () => {},
    migrations: [TIMEZONE_PROBE_MIGRATION],
    startRuntimeServices: false,
  })
  try {
    const headers = {
      apikey: backend.serviceRoleKey,
      authorization: `Bearer ${backend.serviceRoleKey}`,
    }
    const session = await backend.db.query<{ session_timezone: string }>(
      `select current_setting('TimeZone') as session_timezone`
    )
    console.log(JSON.stringify({
      kind: 'data-api',
      session_timezone: session.rows[0].session_timezone,
      table_observed_at: await readTableTimestamp(backend.fetch, headers),
      rpc_observed_at: await readRpcTimestamp(backend.fetch, headers),
    }))
  } finally {
    await backend.close()
  }
}

async function readTableTimestamp(fetchHandler: typeof fetch, headers: Record<string, string>): Promise<string> {
  const response = await fetchHandler(new Request(
    'http://localhost/rest/v1/timezone_probes?select=observed_at',
    { headers }
  ))
  if (!response.ok) throw new Error(`timezone table probe failed with HTTP ${response.status}`)
  const tablePayload: unknown = await response.json()
  if (!Array.isArray(tablePayload) || !isTimestampRecord(tablePayload[0])) {
    throw new Error('timezone table probe returned an invalid payload')
  }
  return tablePayload[0].observed_at
}

async function readRpcTimestamp(fetchHandler: typeof fetch, headers: Record<string, string>): Promise<string> {
  const response = await fetchHandler(new Request(
    'http://localhost/rest/v1/rpc/timezone_probe',
    { method: 'POST', headers, body: '{}' }
  ))
  if (!response.ok) throw new Error(`timezone RPC probe failed with HTTP ${response.status}`)
  const rpcPayload: unknown = await response.json()
  if (typeof rpcPayload !== 'string') throw new Error('timezone RPC probe returned an invalid payload')
  return rpcPayload
}

function isTimestampRecord(candidate: unknown): candidate is { observed_at: string } {
  return typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as Record<string, unknown>).observed_at === 'string'
}

function emitEngineProbe(timezoneRow: TimezoneRow): void {
  console.log(JSON.stringify({ kind: 'engine', ...timezoneRow }))
}
