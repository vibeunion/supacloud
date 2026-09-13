import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'

test('restart preserves application table, sequence, schema and default privileges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-acl-restart-'))
  let backend: Awaited<ReturnType<typeof createBackend>> | undefined
  try {
    backend = await createBackend({ dataDir: join(root, 'db'), startRuntimeServices: false, log: () => {}, migrations: [{
      name: '100_acl', sql: `
        create table public.private_acl(id serial primary key);
        revoke all on public.private_acl from anon, authenticated;
        revoke all on sequence public.private_acl_id_seq from anon, authenticated;
        alter default privileges in schema public revoke all on tables from anon, authenticated;
        alter default privileges in schema public revoke all on sequences from anon, authenticated;
        revoke usage on schema public from public, anon;
      `,
    }] })
    const acl = async (active: Awaited<ReturnType<typeof createBackend>>) => (await active.db.query<unknown>(`
      select has_table_privilege('anon', 'public.private_acl', 'SELECT') as table_select,
        has_sequence_privilege('authenticated', 'public.private_acl_id_seq', 'USAGE') as sequence_usage,
        has_schema_privilege('anon', 'public', 'USAGE') as schema_usage
    `)).rows[0]
    expect(await acl(backend)).toEqual({ table_select: false, sequence_usage: false, schema_usage: false })
    await backend.close()
    backend = await createBackend({ dataDir: join(root, 'db'), startRuntimeServices: false, log: () => {} })
    expect(await acl(backend)).toEqual({ table_select: false, sequence_usage: false, schema_usage: false })
    await backend.db.exec('create table public.after_restart(id serial)')
    const defaults = await backend.db.query<unknown>(`select
      has_table_privilege('authenticated', 'public.after_restart', 'SELECT') as table_select,
      has_sequence_privilege('anon', 'public.after_restart_id_seq', 'USAGE') as sequence_usage`)
    expect(defaults.rows[0]).toEqual({ table_select: false, sequence_usage: false })
  } finally {
    try { await backend?.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
}, 30_000)
