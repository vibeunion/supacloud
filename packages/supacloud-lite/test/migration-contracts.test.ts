import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationBindingSha256 } from '@supacloud/db'
import { loadSupabaseProject } from '../src/runtime/node/project.js'
import { createBackend } from '../src/runtime/index.js'
import { rewriteMigrationSql } from '../src/runtime/db/sql-compat.js'

test('flat and directory migrations share identity and reviewed target bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-migration-contracts-'))
  const base = join(root, 'supabase/migrations')
  const sql = `select '__SC_BINDING_PROJECT__';`
  try {
    await mkdir(join(base, '202609090001_binding'), { recursive: true })
    await writeFile(join(base, '202609090000_initial.sql'), 'select 1;')
    await writeFile(join(base, '202609090001_binding/migration.sql'), sql)
    const bindings = {
      target: { environment: 'local', projectRef: 'local' },
      values: { PROJECT: 'lite-project' },
      manifest: {
        schema: 'supacloud.migration-bindings.v1',
        targets: [{ environment: 'local', projectRef: 'local' }],
        templates: [{ file: '202609090001_binding/migration.sql', templateSha256: migrationBindingSha256(sql),
          parameters: [{ placeholder: '__SC_BINDING_PROJECT__', variable: 'PROJECT', type: 'resource-name', occurrences: 1 }] }],
      },
    }
    await expect(loadSupabaseProject(root)).rejects.toThrow('explicit manifest')
    const project = await loadSupabaseProject(root, { bindings })
    expect(project.migrations).toEqual([
      { name: '202609090000_initial', sql: 'select 1;' },
      { name: '202609090001_binding', sql: `select 'lite-project';` },
    ])
    expect(JSON.stringify(project.bindingAttestation)).not.toContain('lite-project')
    await expect(loadSupabaseProject(root, { bindings: { ...bindings, target: { environment: 'prod', projectRef: 'other' } } })).rejects.toThrow('not registered')
    await expect(loadSupabaseProject(root, { bindings: { ...bindings, values: { PROJECT: "bad'value" } } })).rejects.toThrow('Invalid')
    await writeFile(join(base, '202609090001_duplicate.sql'), 'select 2;')
    await expect(loadSupabaseProject(root, { bindings })).rejects.toThrow('duplicate migration version')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('changed history fails before pending SQL and unchanged history is idempotent', async () => {
  const initial = { name: '100_initial', sql: 'create table public.history_test (id int);' }
  const backend = await createBackend({ migrations: [initial], startRuntimeServices: false })
  try {
    expect(await backend.migrate([initial])).toEqual([])
    await expect(backend.migrate([
      { name: '050_pending', sql: 'create table public.should_not_exist(id int);' },
      { ...initial, sql: initial.sql + '\nselect 1;' },
    ])).rejects.toThrow('content mismatch')
    expect((await backend.db.query(`select to_regclass('public.should_not_exist') as relation`)).rows[0].relation).toBeNull()
    await expect(backend.migrate([initial, { name: '100_duplicate', sql: 'select 1;' }])).rejects.toThrow('duplicate')
    await backend.db.query(`update supabase_migrations.schema_migrations set statements = null where version = '100'`)
    await expect(backend.migrate([initial])).rejects.toThrow('no verifiable SQL')
  } finally { await backend.close() }
})

test('pg_graphql is never silently emulated and strict SQL preserves extension failures', async () => {
  for (const statement of [
    'create extension pg_graphql;',
    'CREATE EXTENSION IF NOT EXISTS "pg_graphql";',
    'create extension /* reviewed */ if not exists pg_graphql;',
    'drop extension if exists pg_graphql;',
  ]) expect(rewriteMigrationSql(statement)).toBe(statement)
  expect(rewriteMigrationSql('create extension missing;', true)).toBe('create extension missing;')
  expect(rewriteMigrationSql('create index concurrently t_idx on t(id);', true)).toContain('concurrently')
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    await expect(backend.migrate([{ name: '101_graphql', sql: 'create extension pg_graphql;' }])).rejects.toThrow()
    expect(await backend.db.listAppliedMigrations()).toEqual([])
  } finally { await backend.close() }
})

test('concurrent migration calls cannot apply two different bodies under one version', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    const results = await Promise.allSettled([
      backend.migrate([{ name: '100_one', sql: 'create table public.concurrent_one(id int);' }]),
      backend.migrate([{ name: '100_two', sql: 'create table public.concurrent_two(id int);' }]),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await backend.db.listAppliedMigrations()).toHaveLength(1)
    expect((await backend.db.query(`select to_regclass('public.concurrent_two') as relation`)).rows[0].relation).toBeNull()
  } finally { await backend.close() }
})
