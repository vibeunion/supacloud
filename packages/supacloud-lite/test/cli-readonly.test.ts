import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'
import { createProjectBackend } from '../src/project-runtime.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const appliedVersion = '20260814010000'
const pendingVersion = '20260814020000'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('read-only CLI commands', () => {
  test('doctor --json reports the stable PGlite capability contract without initializing a database', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-cli-doctor-'))
    temporaryDirectories.push(projectDir)
    const doctor = await runCli(projectDir, ['doctor', '--json'])

    expect(doctor.exitCode).toBe(0)
    expect(doctor.stderr).toBe('')
    expect(JSON.parse(doctor.stdout)).toEqual({
      engine: 'pglite',
      state_machine_sql: 'supported',
      durable_workflows: 'supported',
      commands: 'supported',
      artifacts: 'supported',
      postgrest_schema_config: 'static',
      logical_replication: 'unsupported',
      powersync_source: 'unsupported',
    })
  })

  test('inspect reports the live schema without applying pending migrations or seed', async () => {
    const projectDir = await projectWithPendingMigration()
    const inspection = await runCli(projectDir, ['inspect'])

    expect(inspection.exitCode).toBe(0)
    expect(inspection.stderr).toBe('')
    expect(inspection.stdout).toContain('current_schema')
    expect(inspection.stdout).not.toContain('pending_schema')
    await expectLiveSchemaUnchanged(projectDir)
  }, 30_000)

  test('gen types reads the live schema without applying pending migrations or seed', async () => {
    const projectDir = await projectWithPendingMigration()
    const generatedTypes = await runCli(projectDir, ['gen', 'types'])

    expect(generatedTypes.exitCode).toBe(0)
    expect(generatedTypes.stderr).toBe('')
    expect(generatedTypes.stdout).toContain('current_schema')
    expect(generatedTypes.stdout).not.toContain('pending_schema')
    await expectLiveSchemaUnchanged(projectDir)
  }, 30_000)
})

async function projectWithPendingMigration(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-cli-readonly-'))
  temporaryDirectories.push(projectDir)
  const migrationsDir = join(projectDir, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  await writeFile(
    join(migrationsDir, `${appliedVersion}_current_schema.sql`),
    'create table public.current_schema (id integer primary key);\n'
  )
  const migrated = await runCli(projectDir, ['migrate'])
  expect(migrated.exitCode).toBe(0)
  expect(migrated.stderr).toBe('')
  await writeFile(
    join(migrationsDir, `${pendingVersion}_pending_schema.sql`),
    'create table public.pending_schema (id integer primary key);\n'
  )
  await writeFile(join(projectDir, 'supabase', 'seed.sql'), 'insert into public.current_schema (id) values (1);\n')
  return projectDir
}

async function expectLiveSchemaUnchanged(projectDir: string): Promise<void> {
  const status = await runCli(projectDir, ['status'])
  expect(status.exitCode).toBe(0)
  expect(status.stdout).toContain(appliedVersion)
  expect(status.stdout).not.toContain(pendingVersion)

  const project = await createProjectBackend({
    projectDir,
    applyMigrations: false,
    includeFunctions: false,
    includeWebhooks: false,
    startRuntimeServices: false,
    log: () => {},
  })
  try {
    const pendingTable = await project.backend.db.query<{ name: string | null }>(
      `select to_regclass('public.pending_schema')::text as name`
    )
    const currentRows = await project.backend.db.query<{ count: number }>(
      'select count(*)::int as count from public.current_schema'
    )
    expect(pendingTable.rows[0]?.name).toBeNull()
    expect(currentRows.rows[0]?.count).toBe(0)
  } finally {
    await project.backend.close()
  }
}

async function runCli(projectDir: string, command: string[]) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command, '--project-dir', projectDir],
    cwd: projectDir,
    env: isolatedProjectEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await withWindowsSubprocessRef(() => Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stdout).text(),
    new Response(cliProcess.stderr).text(),
  ]))
  return { exitCode, stdout, stderr }
}

function isolatedProjectEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  delete environment.SUPACLOUD_LITE_JWT_SECRET
  delete environment.SUPACLOUD_LITE_VAULT_KEY
  delete environment.SUPACLOUD_LITE_STATE_DIR
  delete environment.SUPACLOUD_LITE_DATA_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_BACKEND
  delete environment.SUPACLOUD_LITE_REPLICATION_PROFILE
  delete environment.SUPACLOUD_LITE_REPLICATION_HOST
  delete environment.SUPACLOUD_LITE_REPLICATION_PORT
  delete environment.SUPACLOUD_LITE_REPLICATION_ALLOW_CIDRS
  delete environment.SUPACLOUD_LITE_POWERSYNC_TABLES
  delete environment.SUPACLOUD_LITE_POWERSYNC_PASSWORD
  delete environment.SUPACLOUD_LITE_REPLICATION_TLS_CERT_FILE
  delete environment.SUPACLOUD_LITE_REPLICATION_TLS_KEY_FILE
  return environment
}
