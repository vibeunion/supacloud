import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'
import { createSymlinkIfPermitted } from './support/symlink.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')
const initializationError = 'db reset requires initialized state; run "supacloud-lite migrate" first\n'
const invalidMarkerError = 'db reset requires a valid project secrets marker; restore the state before retrying\n'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('db reset CLI', () => {
  // Boundary cases: missing state, empty state, and initialized state with a valid secrets marker.
  test('rejects a missing state without creating it or leaking filesystem details', async () => {
    const projectDir = await temporaryProject()
    const reset = await runCli(projectDir, ['db', 'reset'])

    expect(reset.exitCode).toBe(1)
    expect(reset.stdout).toBe('')
    expect(reset.stderr === initializationError).toBe(true)
    expect(reset.stderr.includes(projectDir)).toBe(false)
    expect(reset.stderr.includes('ENOENT')).toBe(false)
    await expect(access(join(projectDir, '.supacloud-lite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects an empty state without creating a secrets marker', async () => {
    const projectDir = await temporaryProject()
    const stateDir = join(projectDir, '.supacloud-lite')
    await mkdir(stateDir)

    const reset = await runCli(projectDir, ['db', 'reset'])

    expect(reset.exitCode).toBe(1)
    expect(reset.stdout).toBe('')
    expect(reset.stderr === initializationError).toBe(true)
    expect(reset.stderr.includes(projectDir)).toBe(false)
    expect(reset.stderr.includes('ENOENT')).toBe(false)
    expect(await readdir(stateDir)).toEqual([])
  })

  test('resets initialized state without replacing its secrets', async () => {
    const projectDir = await temporaryProject()
    const migrationsDir = join(projectDir, 'supabase', 'migrations')
    const migrationVersion = '20260811000000'
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(
      join(migrationsDir, `${migrationVersion}_reset_contract.sql`),
      'create table public.reset_contract (id bigint primary key);\n'
    )

    const migrated = await runCli(projectDir, ['migrate'])
    expect(migrated.exitCode).toBe(0)
    expect(migrated.stderr).toBe('')
    const secretsPath = join(projectDir, '.supacloud-lite', 'secrets.json')
    const secretsBeforeReset = await readFile(secretsPath, 'utf8')

    const reset = await runCli(projectDir, ['db', 'reset'])
    expect(reset.exitCode).toBe(0)
    expect(reset.stderr).toBe('')
    expect(reset.stdout).toBe('reset complete: 1 migration(s) applied\n')
    expect((await readFile(secretsPath, 'utf8')) === secretsBeforeReset).toBe(true)

    const status = await runCli(projectDir, ['status'])
    expect(status.exitCode).toBe(0)
    expect(status.stdout.includes(migrationVersion)).toBe(true)
  }, 30_000)

  test('preserves database and storage when the secrets marker is invalid', async () => {
    const projectDir = await temporaryProject()
    const stateDir = join(projectDir, '.supacloud-lite')
    const dataSentinel = join(stateDir, 'db', 'database.sentinel')
    const storageSentinel = join(stateDir, 'storage', 'storage.sentinel')
    const secretsPath = join(stateDir, 'secrets.json')
    await mkdir(join(stateDir, 'db'), { recursive: true })
    await mkdir(join(stateDir, 'storage'))
    await writeFile(dataSentinel, 'database preserved')
    await writeFile(storageSentinel, 'storage preserved')
    await writeFile(secretsPath, '{}\n')

    const reset = await runCli(projectDir, ['db', 'reset'])
    expect(reset.exitCode).toBe(1)
    expect(reset.stdout).toBe('')
    expect(reset.stderr === invalidMarkerError).toBe(true)
    expect(reset.stderr.includes(projectDir)).toBe(false)
    expect(reset.stderr.includes('ENOENT')).toBe(false)
    expect(await readFile(dataSentinel, 'utf8')).toBe('database preserved')
    expect(await readFile(storageSentinel, 'utf8')).toBe('storage preserved')
    expect(await readFile(secretsPath, 'utf8')).toBe('{}\n')
  })

  test('preserves state and redacts paths when the secrets marker is a directory', async () => {
    const projectDir = await temporaryProject()
    const stateDir = join(projectDir, '.supacloud-lite')
    const dataSentinel = join(stateDir, 'db', 'database.sentinel')
    const storageSentinel = join(stateDir, 'storage', 'storage.sentinel')
    const markerDirectory = join(stateDir, 'secrets.json')
    const markerSentinel = join(markerDirectory, 'marker.sentinel')
    await mkdir(join(stateDir, 'db'), { recursive: true })
    await mkdir(join(stateDir, 'storage'))
    await mkdir(markerDirectory)
    await writeFile(dataSentinel, 'database preserved')
    await writeFile(storageSentinel, 'storage preserved')
    await writeFile(markerSentinel, 'directory marker preserved')

    const reset = await runCli(projectDir, ['db', 'reset'])

    expect(reset.exitCode).toBe(1)
    expect(reset.stdout).toBe('')
    expect(reset.stderr).toBe(invalidMarkerError)
    expect(reset.stderr.includes(projectDir)).toBe(false)
    expect(reset.stderr.includes('ENOENT')).toBe(false)
    expect(await readFile(dataSentinel, 'utf8')).toBe('database preserved')
    expect(await readFile(storageSentinel, 'utf8')).toBe('storage preserved')
    expect(await readFile(markerSentinel, 'utf8')).toBe('directory marker preserved')
  })

  test('preserves state and redacts paths when the secrets marker is a symbolic link', async () => {
    const projectDir = await temporaryProject()
    const stateDir = join(projectDir, '.supacloud-lite')
    const dataSentinel = join(stateDir, 'db', 'database.sentinel')
    const storageSentinel = join(stateDir, 'storage', 'storage.sentinel')
    const secretsPath = join(stateDir, 'secrets.json')
    const externalMarker = join(projectDir, 'external-secrets.json')
    const externalSecret = 'must-not-appear-in-reset-output'
    await mkdir(join(stateDir, 'db'), { recursive: true })
    await mkdir(join(stateDir, 'storage'))
    await writeFile(dataSentinel, 'database preserved')
    await writeFile(storageSentinel, 'storage preserved')
    await writeFile(externalMarker, externalSecret)
    if (!await createSymlinkIfPermitted(externalMarker, secretsPath)) return

    const reset = await runCli(projectDir, ['db', 'reset'])

    expect(reset.exitCode).toBe(1)
    expect(reset.stdout).toBe('')
    expect(reset.stderr).toBe(invalidMarkerError)
    expect(reset.stderr.includes(projectDir)).toBe(false)
    expect(reset.stderr.includes('ENOENT')).toBe(false)
    expect(reset.stderr.includes(externalSecret)).toBe(false)
    expect(await readFile(dataSentinel, 'utf8')).toBe('database preserved')
    expect(await readFile(storageSentinel, 'utf8')).toBe('storage preserved')
    expect(await readFile(externalMarker, 'utf8')).toBe(externalSecret)
  })

  test('directs fresh projects to migrate in CLI help', async () => {
    const help = await runCli(await temporaryProject(), ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stderr).toBe('')
    expect(help.stdout).toContain('Fresh projects must run "supacloud-lite migrate" before "db reset".')
  })
})

async function temporaryProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-db-reset-'))
  temporaryDirectories.push(projectDir)
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
  delete environment.SUPACLOUD_LITE_VAULT_KEY
  delete environment.SUPACLOUD_LITE_STATE_DIR
  delete environment.SUPACLOUD_LITE_DATA_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_BACKEND
  return environment
}
