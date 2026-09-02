import { afterEach, describe, expect, test } from 'bun:test'
import { testTimeout } from './helpers/timeouts.js'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('db check', () => {
  test('reconciles declared modules against the live catalog', async () => {
    const projectDir = await moduleProject({ declareMissingPolicy: false })
    await runCli(projectDir, ['migrate'])

    const check = await runCli(projectDir, ['db', 'check'])
    expect(check.stderr).toBe('')
    expect(check.stdout).toContain('module docs:')
    expect(check.stdout).toContain('ok')
    expect(check.exitCode).toBe(0)
  }, testTimeout(60_000))

  test('fails with a non-zero exit code when a declared policy is missing', async () => {
    const projectDir = await moduleProject({ declareMissingPolicy: true })
    await runCli(projectDir, ['migrate'])

    const check = await runCli(projectDir, ['db', 'check'])
    expect(check.stdout).toContain('missing-policy')
    expect(check.exitCode).toBe(1)
  }, testTimeout(60_000))

  test('reports a clear error when the module manifest is absent', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-db-check-empty-'))
    temporaryDirectories.push(projectDir)

    const check = await runCli(projectDir, ['db', 'check'])
    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('database module manifest not found')
  }, testTimeout(60_000))
})

async function moduleProject(options: { declareMissingPolicy: boolean }): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-db-check-'))
  temporaryDirectories.push(projectDir)
  // The manifest imports @supacloud/db; give the fixture project a
  // node_modules link like a real project checkout would have.
  await symlink(join(packageRoot, 'node_modules'), join(projectDir, 'node_modules'))
  await mkdir(join(projectDir, 'supabase', 'migrations'), { recursive: true })
  await mkdir(join(projectDir, 'supabase', 'db', 'sql'), { recursive: true })

  await writeFile(
    join(projectDir, 'supabase', 'migrations', '20260902010000_init.sql'),
    `create table public.docs (
  id uuid primary key default gen_random_uuid(),
  title text not null
);

alter table public.docs enable row level security;

create policy docs_select on public.docs
  for select to authenticated
  using (true);

create function public.docs_count()
returns bigint
language sql
security invoker
as $$ select count(*) from public.docs $$;
`
  )

  await writeFile(
    join(projectDir, 'supabase', 'db', 'sql', 'docs_select.sql'),
    `alter table public.docs enable row level security;

drop policy if exists docs_select on public.docs;

create policy docs_select on public.docs
  for select to authenticated
  using (true);
`
  )
  await writeFile(
    join(projectDir, 'supabase', 'db', 'sql', 'docs_count.sql'),
    `create function public.docs_count()
returns bigint
language sql
security invoker
as $$ select count(*) from public.docs $$;
`
  )

  await writeFile(
    join(projectDir, 'supabase', 'db', 'sql', 'docs.test.sql'),
    `-- @test docs are readable
select 1 from public.docs;
`
  )

  const missingPolicyDecl = options.declareMissingPolicy
    ? `,
    {
      name: 'docs_insert',
      table: 'public.docs',
      operation: 'insert',
      roles: ['authenticated'],
      source: 'sql/docs_select.sql',
    }`
    : ''
  await writeFile(
    join(projectDir, 'supabase', 'db', 'modules.ts'),
    `import { defineDatabaseModule } from '@supacloud/db'

export default defineDatabaseModule({
  name: 'docs',
  tables: ['public.docs'],
  policies: [
    {
      name: 'docs_select',
      table: 'public.docs',
      operation: 'select',
      roles: ['authenticated'],
      source: 'sql/docs_select.sql',
      tests: ['sql/docs.test.sql'],
    }${missingPolicyDecl}
  ],
  functions: [
    {
      name: 'public.docs_count',
      source: 'sql/docs_count.sql',
      security: 'invoker',
      tests: ['sql/docs.test.sql'],
    },
  ],
})
`
  )
  return projectDir
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
  delete environment.SUPACLOUD_LITE_HOST
  delete environment.SUPACLOUD_LITE_PORT
  return environment
}
