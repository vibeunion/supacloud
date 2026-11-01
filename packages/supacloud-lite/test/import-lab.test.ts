import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EDGE_RUNTIME_PACKAGE_VERSION,
  REALTIME_IMAGE_TAG,
  SUPABASE_CLI_PIN,
  SUPABASE_JS_PIN,
} from '../src/compat-matrix.js'
import { testTimeout } from './helpers/timeouts.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const repoRoot = resolve(import.meta.dir, '../../..')
const temporaryDirectories: string[] = []
const password = 'lab-password-not-for-stdout'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test('compat prints the five pins unchecked', async () => {
  const projectDir = await tempDir('compat-')
  const result = await runCli(projectDir, ['compat', '--json'])
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout) as { deployed: boolean; version_matrix: Array<{ component: string; checked: boolean; blocker: string | null }> }
  expect(report.deployed).toBe(false)
  expect(report.version_matrix.map((row) => row.component)).toEqual([
    'supabase-js', 'cli', 'realtime', 'storage', 'edge-functions',
  ])
  expect(report.version_matrix.every((row) => row.checked === false && row.blocker)).toBe(true)
  expect(result.stdout).not.toContain(password)
})

test('declared pins match the repository sources', async () => {
  const lite = JSON.parse(await readFile(join(repoRoot, 'packages/supacloud-lite/package.json'), 'utf8')) as {
    devDependencies: Record<string, string>
  }
  const edge = JSON.parse(await readFile(join(repoRoot, 'packages/edge-runtime/package.json'), 'utf8')) as { version: string }
  const adoption = await readFile(join(repoRoot, 'docs/supabase-upstream-adoption.md'), 'utf8')
  const installer = await readFile(join(repoRoot, 'install.sh'), 'utf8')
  expect(lite.devDependencies['@supabase/supabase-js']).toContain(SUPABASE_JS_PIN)
  expect(adoption).toContain(SUPABASE_CLI_PIN)
  expect(installer).toContain(`public.ecr.aws/supabase/realtime:${REALTIME_IMAGE_TAG}`)
  expect(edge.version).toBe(EDGE_RUNTIME_PACKAGE_VERSION)
})

test('import refuses a symlinked migration and does not mark the checklist passed', async () => {
  const projectDir = await tempDir('symlink-')
  const migrations = join(projectDir, 'supabase', 'migrations')
  await mkdir(migrations, { recursive: true })
  await writeFile(join(migrations, '20260814010000_notes.sql'), 'select 1;\n')
  await symlink('20260814010000_notes.sql', join(migrations, '20260814010001_link.sql'))
  const result = await runCli(projectDir, ['import', '--from', projectDir, '--project-dir', projectDir, '--json'])
  expect(result.exitCode).toBe(1)
  const report = JSON.parse(result.stdout) as Report
  expect(report.deployed).toBe(false)
  const migrationsRow = row(report, 'migrations')
  expect(migrationsRow.checked).toBe(false)
  expect(migrationsRow.attempted).toBe(true)
  expect(migrationsRow.blocker).toMatch(/symbolic link/i)
  expect(result.stdout).not.toContain(password)
}, testTimeout(30_000))

test('a migration-only project leaves unverified rows unchecked', async () => {
  const projectDir = await tempDir('migrations-only-')
  await writeMigration(projectDir)
  const result = await runCli(projectDir, ['import', '--from', projectDir, '--project-dir', projectDir, '--json', '--memory', '--storage-backend', 'memory'])
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout) as Report
  expect(row(report, 'migrations')).toMatchObject({ checked: true, attempted: true })
  for (const id of ['config', 'data', 'acl', 'objects', 'functions', 'auth'] as const) {
    expect(row(report, id).checked).toBe(false)
    expect(row(report, id).attempted).toBe(false)
    expect(row(report, id).blocker).toBeTruthy()
  }
  expect(report.version_matrix.find((item) => item.component === 'supabase-js')?.checked).toBe(false)
  expect(report.version_matrix.find((item) => item.component === 'realtime')?.checked).toBe(false)
}, testTimeout(60_000))

test('a wrong row-count expectation stays unchecked', async () => {
  const projectDir = await tempDir('mismatch-')
  await writeMigration(projectDir)
  await mkdir(join(projectDir, 'supabase', 'import'), { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'import', 'data.sql'), "insert into public.notes (id, body) values (1, 'imported');\n")
  await writeFile(join(projectDir, 'supabase', 'import', 'expectations.json'), JSON.stringify({
    data: [{ table: 'notes', rows: 9 }],
  }))
  const result = await runCli(projectDir, ['import', '--from', projectDir, '--project-dir', projectDir, '--json', '--memory', '--storage-backend', 'memory'])
  expect(result.exitCode).toBe(1)
  const report = JSON.parse(result.stdout) as Report
  const data = row(report, 'data')
  expect(data.checked).toBe(false)
  expect(data.attempted).toBe(true)
  expect(data.blocker).toContain('expected 9')
  expect(report.deployed).toBe(false)
}, testTimeout(60_000))

test('import copies a project, verifies the checklist, then refuses a changed data file', async () => {
  const source = await tempDir('source-')
  const destination = await tempDir('dest-')
  await writeFullProject(source)
  const first = await runCli(destination, ['import', '--from', source, '--project-dir', destination, '--json'])
  expect(first.stderr).toBe('')
  expect(first.exitCode).toBe(0)
  const imported = JSON.parse(first.stdout) as Report
  expect(imported.deployed).toBe(false)
  for (const id of ['config', 'migrations', 'data', 'acl', 'objects', 'functions', 'auth'] as const) {
    expect(row(imported, id).checked, row(imported, id).blocker).toBe(true)
  }
  expect(imported.version_matrix.find((item) => item.component === 'supabase-js')).toMatchObject({
    declared_version: SUPABASE_JS_PIN,
    observed_version: SUPABASE_JS_PIN,
    checked: true,
    blocker: null,
  })
  for (const component of ['cli', 'realtime', 'storage', 'edge-functions']) {
    expect(imported.version_matrix.find((item) => item.component === component)?.checked).toBe(false)
  }
  expect(first.stdout).not.toContain(password)
  expect(await readFile(join(destination, 'supabase', 'config.toml'), 'utf8')).toContain('[storage.buckets.docs]')

  const second = await runCli(destination, ['import', '--from', source, '--project-dir', destination, '--json'])
  expect(second.exitCode).toBe(0)
  expect(second.stderr).toBe('')
  expect(second.stdout).not.toContain(password)

  const changed = "insert into public.notes (id, body) values (2, 'changed') on conflict (id) do nothing;\n"
  await writeFile(join(source, 'supabase', 'import', 'data.sql'), changed)
  await writeFile(join(destination, 'supabase', 'import', 'data.sql'), changed)
  const third = await runCli(destination, ['import', '--from', source, '--project-dir', destination, '--json'])
  expect(third.exitCode).toBe(1)
  const refused = JSON.parse(third.stdout) as Report
  expect(row(refused, 'data').checked).toBe(false)
  expect(row(refused, 'data').blocker).toMatch(/changed after it was applied/)
  expect(row(refused, 'migrations').checked).toBe(true)
  expect(refused.deployed).toBe(false)
  expect(third.stdout).not.toContain(password)
}, testTimeout(120_000))

async function writeFullProject(projectDir: string): Promise<void> {
  await writeMigration(projectDir)
  await mkdir(join(projectDir, 'supabase', 'functions', 'hello'), { recursive: true })
  await mkdir(join(projectDir, 'supabase', 'import', 'storage', 'docs'), { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'config.toml'), [
    '[storage.buckets.docs]',
    'public = false',
    '',
    '[functions.hello]',
    'verify_jwt = true',
    '',
  ].join('\n'))
  await writeFile(join(projectDir, 'supabase', 'functions', 'hello', 'index.ts'), 'export default () => Response.json({ ok: true })\n')
  await writeFile(join(projectDir, 'supabase', 'import', 'data.sql'), "insert into public.notes (id, body) values (1, 'imported') on conflict (id) do nothing;\n")
  await writeFile(join(projectDir, 'supabase', 'import', 'storage', 'docs', 'hello.txt'), 'hello')
  await writeFile(join(projectDir, 'supabase', 'import', 'auth-users.json'), JSON.stringify({
    users: [{ email: 'ada@example.test', password, email_confirm: true }],
  }))
  await writeFile(join(projectDir, 'supabase', 'import', 'expectations.json'), JSON.stringify({
    data: [{ table: 'notes', rows: 1 }],
    acl: [{ table: 'notes', anon_rows: 0, service_rows: 1 }],
    functions: [{ name: 'hello', status: 200, body: '{"ok":true}' }],
  }))
}

async function writeMigration(projectDir: string): Promise<void> {
  const migrations = join(projectDir, 'supabase', 'migrations')
  await mkdir(migrations, { recursive: true })
  await writeFile(join(migrations, '20260814010000_notes.sql'), [
    'create table public.notes (',
    '  id integer primary key,',
    '  body text not null',
    ');',
    'alter table public.notes enable row level security;',
    '',
  ].join('\n'))
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `supacloud-import-${prefix}`))
  temporaryDirectories.push(directory)
  return directory
}

interface Report {
  deployed: boolean
  checklist: Array<{ id: string; checked: boolean; attempted: boolean; blocker?: string; detail?: string }>
  version_matrix: Array<{ component: string; declared_version: string; observed_version: string | null; checked: boolean; blocker: string | null }>
}

function row(report: Report, id: string) {
  const found = report.checklist.find((item) => item.id === id)
  if (!found) throw new Error(`missing checklist row ${id}`)
  return found
}

async function runCli(projectDir: string, command: string[]) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command],
    cwd: projectDir,
    env: isolatedProjectEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stdout).text(),
    new Response(cliProcess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function isolatedProjectEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SUPACLOUD_LITE_')) delete environment[key]
  }
  return environment
}
