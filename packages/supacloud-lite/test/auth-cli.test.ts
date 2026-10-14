import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProjectBackend } from '../src/project-runtime.js'
import { loadAuthSettings, saveAuthSettings } from '../src/runtime/auth/settings.js'
import { testTimeout } from './helpers/timeouts.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const password = 'correct-horse-battery-staple'
const authConfig = '[auth]\nenabled = true\nenable_signup = false\nminimum_password_length = 12\n[auth.email]\nenable_confirmations = true\n'
const createArgs = ['auth', 'create-user', '--email', 'admin@example.com', '--password-stdin']
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('auth create-user CLI', () => {
  test('creates a confirmed user with signup disabled without applying migrations or seed', async () => {
    const projectDir = await projectWithAuthMigration()
    await writeFile(
      join(projectDir, 'supabase', 'migrations', '20261014020000_pending.sql'),
      'create table public.pending_auth_cli (id integer primary key);\n',
    )

    await writeFile(join(projectDir, 'supabase', 'seed.sql'), 'insert into public.auth_cli_fixture values (1);\n')
    const result = await runCli(projectDir, [
      'auth', 'create-user', '--email', 'Admin@Example.com', '--password-stdin', '--email-confirm', '--json',
    ], `${password}\r\n`)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const created = JSON.parse(result.stdout) as { id: string; email: string; email_confirmed: boolean }
    expect(Object.keys(created).sort()).toEqual(['email', 'email_confirmed', 'id'])
    expect(created).toMatchObject({ email: 'admin@example.com', email_confirmed: true })
    expect(result.stdout).not.toContain(password)

    const project = await openProject(projectDir)
    try {
      const pending = await project.backend.db.query<{ name: string | null }>(
        `select to_regclass('public.pending_auth_cli')::text as name`,
      )
      expect(pending.rows[0]?.name).toBeNull()
      const seeded = await project.backend.db.query('select * from public.auth_cli_fixture')
      expect(seeded.rows).toHaveLength(0)
      const identities = await project.backend.db.query('select provider from auth.identities where user_id = $1', [created.id])
      expect(identities.rows).toEqual([{ provider: 'email' }])
      expect(result.stdout).not.toContain(project.backend.serviceRoleKey)
      expect(result.stdout).not.toContain(project.backend.jwtSecret)
      const client = clientFor(project)
      const signup = await client.auth.signUp({ email: 'public@example.com', password })
      expect(signup.error).not.toBeNull()
      const login = await client.auth.signInWithPassword({ email: 'admin@example.com', password })
      expect(login.error).toBeNull()
      expect(login.data.user?.id).toBe(created.id)
      expect(login.data.user?.email).toBe('admin@example.com')
      expect(login.data.session).not.toBeNull()
      const locked = await runCli(projectDir, [...createArgs, '--email-confirm'], password)
      expect(locked.exitCode).toBe(1)
      expect(locked.stderr).toContain('already in use')
    } finally {
      await project.backend.close()
    }
  }, testTimeout(60_000))

  test('rejects password arguments and duplicate emails without leaking the password', async () => {
    const projectDir = await projectWithAuthMigration()
    const argumentPassword = await runCli(projectDir, [
      'auth', 'create-user', '--email', 'argument@example.com', '--password', password,
    ])
    expect(argumentPassword.exitCode).toBe(1)
    expect(argumentPassword.stderr).toContain('password arguments are not supported')
    expect(argumentPassword.stderr).not.toContain(password)

    const first = await runCli(projectDir, [
      'auth', 'create-user', '--email', 'duplicate@example.com', '--password-stdin', '--email-confirm',
    ], password)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('email confirmed: yes')
    expect(first.stdout).not.toContain(password)

    const duplicate = await runCli(projectDir, [
      'auth', 'create-user', '--email', 'DUPLICATE@example.com', '--password-stdin', '--email-confirm',
    ], 'another-password')
    expect(duplicate.exitCode).toBe(1)
    expect(duplicate.stderr).toContain('already exists; no changes made')
    expect(duplicate.stderr).not.toContain('another-password')
    const project = await openProject(projectDir)
    try {
      const client = clientFor(project)
      const login = await client.auth.signInWithPassword({ email: 'duplicate@example.com', password })
      expect(login.error).toBeNull()
      const count = await project.backend.db.query<{ count: number }>('select count(*)::int as count from auth.users')
      expect(count.rows[0]?.count).toBe(1)
    } finally {
      await project.backend.close()
    }
  }, testTimeout(60_000))

  test('requires explicit email confirmation and preserves password whitespace', async () => {
    const projectDir = await newProject()
    const spacedPassword = ` ${password} `
    const result = await runCli(projectDir, [...createArgs, '--json'], `${spacedPassword}\n`)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ email: 'admin@example.com', email_confirmed: false })
    const project = await openProject(projectDir)
    try {
      const client = clientFor(project)
      const blocked = await client.auth.signInWithPassword({ email: 'admin@example.com', password: spacedPassword })
      expect(blocked.error?.code).toBe('email_not_confirmed')
      expect(blocked.data.session).toBeNull()
      const admin = createClient('http://local', project.backend.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: project.backend.fetch },
      })
      const user = JSON.parse(result.stdout) as { id: string }
      expect((await admin.auth.admin.updateUserById(user.id, { email_confirm: true })).error).toBeNull()
      const login = await client.auth.signInWithPassword({ email: 'admin@example.com', password: spacedPassword })
      expect(login.error).toBeNull()
      expect(login.data.session).not.toBeNull()
      const trimmed = await clientFor(project).auth.signInWithPassword({ email: 'admin@example.com', password })
      expect(trimmed.error?.code).toBe('invalid_credentials')
    } finally {
      await project.backend.close()
    }
  }, testTimeout(60_000))

  test('enforces config and persisted password policy without creating users', async () => {
    const projectDir = await newProject()
    const weak = await runCli(projectDir, createArgs, 'too-short')
    expect(weak.exitCode).toBe(1)
    expect(weak.stderr).toContain('at least 12 characters')
    expect(weak.stderr).not.toContain('too-short')
    const project = await openProject(projectDir)
    try {
      const settings = await loadAuthSettings(project.backend.db, project.config.auth.settings)
      await saveAuthSettings(project.backend.db, { ...settings, minPasswordLength: 40 })
    } finally {
      await project.backend.close()
    }
    const persisted = await runCli(projectDir, createArgs, password)
    expect(persisted.exitCode).toBe(1)
    expect(persisted.stderr).toContain('at least 40 characters')
    expect(persisted.stderr).not.toContain(password)
    const reopened = await openProject(projectDir)
    try {
      expect((await reopened.backend.db.query('select id from auth.users')).rows).toHaveLength(0)
    } finally {
      await reopened.backend.close()
    }
  }, testTimeout(60_000))

  test('rejects local provisioning when Auth is disabled or external identity is configured', async () => {
    const disabled = await newProject('[auth]\nenabled = false\n')
    const disabledResult = await runCli(disabled, [
      'auth', 'create-user', '--email', 'disabled@example.com', '--password-stdin', '--email-confirm',
    ], password)
    expect(disabledResult.exitCode).toBe(1)
    expect(disabledResult.stderr).toContain('Auth is disabled')
    expect(existsSync(join(disabled, '.supacloud-lite'))).toBe(false)

    const external = await newProject(
      '[auth]\nenabled = true\n[lite.identity]\nmodule = "identity.ts"\n',
    )
    await writeFile(join(external, 'identity.ts'), 'throw new Error("identity module must not execute")\n')
    const externalResult = await runCli(external, [
      'auth', 'create-user', '--email', 'external@example.com', '--password-stdin', '--email-confirm',
    ], password)
    expect(externalResult.exitCode).toBe(1)
    expect(externalResult.stderr).toContain('external identity')
    expect(existsSync(join(external, '.supacloud-lite'))).toBe(false)
  }, testTimeout(30_000))

  test('rejects invalid input before initializing a project and never echoes password arguments', async () => {
    const projectDir = await newProject()
    const cases: Array<{ args: string[]; input?: string; error: string }> = [
      { args: ['auth', 'create-user'], error: 'valid --email' },
      { args: ['auth', 'create-user', '--email', 'admin@example.com'], error: 'requires --password-stdin' },
      { args: [...createArgs, '--email', 'invalid-email'], input: password, error: 'valid --email' },
      { args: [...createArgs, '--memory'], input: password, error: 'persistent project' },
      { args: [...createArgs, '--identity-module', 'missing.ts'], input: password, error: 'external identity' },
      { args: createArgs, error: 'one non-empty line' },
      { args: createArgs, input: '\n', error: 'one non-empty line' },
      { args: createArgs, input: 'first\nsecond', error: 'one non-empty line' },
      { args: createArgs, input: 'invalid\x00password', error: 'one non-empty line' },
      { args: createArgs, input: 'x'.repeat(4097), error: 'exceeds 4096 bytes' },
      { args: [...createArgs, `--password=${password}`], error: 'password arguments are not supported' },
      { args: [...createArgs, `--password-stdin=${password}`], error: 'password arguments are not supported' },
      { args: ['auth', 'delete-user'], error: 'usage: auth create-user' },
      { args: ['start', '--password-stdin'], error: 'only supported by auth create-user' },
    ]
    for (const entry of cases) {
      const result = await runCli(projectDir, entry.args, entry.input)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(entry.error)
      expect(result.stderr).not.toContain(password)
      expect(existsSync(join(projectDir, '.supacloud-lite'))).toBe(false)
    }
  }, testTimeout(30_000))
})

async function newProject(config = authConfig): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-auth-cli-'))
  temporaryDirectories.push(projectDir)
  await mkdir(join(projectDir, 'supabase', 'migrations'), { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'config.toml'), config)
  return projectDir
}

async function projectWithAuthMigration(): Promise<string> {
  const projectDir = await newProject()
  await writeFile(
    join(projectDir, 'supabase', 'migrations', '20261014010000_init.sql'),
    'create table public.auth_cli_fixture (id integer primary key);\n',
  )
  const migrated = await runCli(projectDir, ['migrate'])
  expect(migrated.exitCode).toBe(0)
  expect(migrated.stderr).toBe('')
  return projectDir
}

async function runCli(projectDir: string, command: string[], stdin?: string) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command, '--project-dir', projectDir],
    cwd: projectDir,
    env: isolatedProjectEnvironment(),
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: testTimeout(30_000),
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
  delete environment.PORT
  return environment
}

async function openProject(projectDir: string) {
  const stateDir = join(projectDir, '.supacloud-lite')
  return createProjectBackend({
    projectDir,
    stateDir,
    dataDir: join(stateDir, 'db'),
    storageDir: join(stateDir, 'storage'),
    engine: 'pglite',
    host: '127.0.0.1',
    port: 54321,
    storageBackend: 'memory',
    applyMigrations: false,
    includeSeed: false,
    includeFunctions: false,
    includeWebhooks: false,
    startRuntimeServices: false,
    log: () => {},
  })
}

function clientFor(project: Awaited<ReturnType<typeof openProject>>) {
  return createClient('http://local', project.backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: project.backend.fetch },
  })
}
