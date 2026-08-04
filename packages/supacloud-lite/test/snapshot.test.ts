import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectBackend, ensureProjectSecrets, resolveProjectPaths } from '../src/project-runtime.js'
import { createSnapshot, restoreSnapshot } from '../src/snapshot.js'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'
import { createSymlinkIfPermitted } from './support/symlink.js'

const temporaryDirectories: string[] = []
const WINDOWS_CLI_TIMEOUT_MS = 20_000
const WINDOWS_CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Lite snapshots', () => {
  test('creates one compressed archive and restores database, storage, and secrets', async () => {
    const sourceProject = await temporaryProject('supacloud-lite-snapshot-source-')
    const sourcePaths = resolveProjectPaths({ projectDir: sourceProject })
    await ensureProjectSecrets(sourcePaths)
    await mkdir(sourcePaths.dataDir!, { recursive: true })
    await mkdir(sourcePaths.storageDir, { recursive: true })
    await writeFile(join(sourcePaths.dataDir!, 'database.bin'), new Uint8Array([1, 2, 3, 4]))
    await writeFile(join(sourcePaths.storageDir, 'avatar.txt'), 'storage-bytes')
    const originalSecrets = await readFile(sourcePaths.secretsFile, 'utf8')
    const archivePath = join(sourceProject, 'portable.tar.gz')

    const manifest = await createSnapshot({
      paths: sourcePaths,
      packageVersion: 'test-version',
      storageBackend: 'fs',
      output: archivePath,
    })

    expect(manifest).toMatchObject({ packageVersion: 'test-version', storageBackend: 'fs' })
    expect((await stat(archivePath)).size).toBeGreaterThan(0)
    if (process.platform !== 'win32') expect((await stat(archivePath)).mode & 0o777).toBe(0o600)

    const targetProject = await temporaryProject('supacloud-lite-snapshot-target-')
    const targetPaths = resolveProjectPaths({ projectDir: targetProject })
    const restored = await restoreSnapshot({
      paths: targetPaths,
      storageBackend: 'fs',
      input: archivePath,
    })

    expect(restored.rollbackPaths).toEqual([])
    expect(await Bun.file(join(targetPaths.dataDir!, 'database.bin')).bytes()).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(await readFile(join(targetPaths.storageDir, 'avatar.txt'), 'utf8')).toBe('storage-bytes')
    expect(await readFile(targetPaths.secretsFile, 'utf8')).toBe(originalSecrets)
    if (process.platform !== 'win32') {
      expect((await stat(targetPaths.stateDir)).mode & 0o777).toBe(0o700)
      expect((await stat(targetPaths.dataDir!)).mode & 0o777).toBe(0o700)
      expect((await stat(targetPaths.storageDir)).mode & 0o777).toBe(0o700)
      expect((await stat(targetPaths.secretsFile)).mode & 0o777).toBe(0o600)
      expect((await stat(join(targetPaths.dataDir!, 'database.bin'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(targetPaths.storageDir, 'avatar.txt'))).mode & 0o777).toBe(0o600)
    }
  })

  test('refuses non-empty restore targets unless force retains a rollback copy', async () => {
    const sourceProject = await temporaryProject('supacloud-lite-snapshot-force-source-')
    const sourcePaths = resolveProjectPaths({ projectDir: sourceProject })
    await ensureProjectSecrets(sourcePaths)
    await mkdir(sourcePaths.dataDir!, { recursive: true })
    await mkdir(sourcePaths.storageDir, { recursive: true })
    await writeFile(join(sourcePaths.dataDir!, 'new.txt'), 'new')
    const archivePath = join(sourceProject, 'force.tar.gz')
    await createSnapshot({ paths: sourcePaths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })

    const targetProject = await temporaryProject('supacloud-lite-snapshot-force-target-')
    const targetPaths = resolveProjectPaths({ projectDir: targetProject })
    await ensureProjectSecrets(targetPaths)
    await mkdir(targetPaths.dataDir!, { recursive: true })
    await writeFile(join(targetPaths.dataDir!, 'old.txt'), 'old')

    await expect(restoreSnapshot({ paths: targetPaths, storageBackend: 'fs', input: archivePath })).rejects.toThrow('not empty')
    expect(await readFile(join(targetPaths.dataDir!, 'old.txt'), 'utf8')).toBe('old')

    const restored = await restoreSnapshot({ paths: targetPaths, storageBackend: 'fs', input: archivePath, force: true })
    expect(await readFile(join(targetPaths.dataDir!, 'new.txt'), 'utf8')).toBe('new')
    expect(restored.rollbackPaths).toHaveLength(1)
    expect(await readFile(join(restored.rollbackPaths[0]!, 'db', 'old.txt'), 'utf8')).toBe('old')
  })

  test('rejects active locks, symlinks, backend mismatches, and existing outputs', async () => {
    const projectDir = await temporaryProject('supacloud-lite-snapshot-guards-')
    const paths = resolveProjectPaths({ projectDir })
    await ensureProjectSecrets(paths)
    await mkdir(paths.dataDir!, { recursive: true })
    await mkdir(paths.storageDir, { recursive: true })
    const archivePath = join(projectDir, 'guards.tar.gz')

    await writeFile(`${paths.dataDir}.supacloud-lite.lock`, JSON.stringify({ pid: process.pid, nonce: 'active' }))
    await expect(
      createSnapshot({ paths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })
    ).rejects.toThrow('already in use')
    await rm(`${paths.dataDir}.supacloud-lite.lock`)

    await writeFile(`${paths.dataDir}.supacloud-lite.lock`, '{}')
    await expect(
      createSnapshot({ paths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })
    ).rejects.toThrow('unreadable lock')
    await rm(`${paths.dataDir}.supacloud-lite.lock`)

    await writeFile(`${paths.dataDir}.supacloud-lite.lock`, JSON.stringify({ pid: 999_999, nonce: 'stale' }))
    await createSnapshot({ paths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })
    await expect(
      createSnapshot({ paths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })
    ).rejects.toThrow('already exists')

    const targetProject = await temporaryProject('supacloud-lite-snapshot-backend-')
    await expect(
      restoreSnapshot({ paths: resolveProjectPaths({ projectDir: targetProject }), storageBackend: 's3', input: archivePath })
    ).rejects.toThrow('storage backend')

    const external = await temporaryProject('supacloud-lite-snapshot-link-target-')
    if (await createSymlinkIfPermitted(external, join(paths.storageDir, 'linked'))) {
      await expect(
        createSnapshot({ paths, packageVersion: 'test-version', storageBackend: 'fs', output: join(projectDir, 'linked.tar.gz') })
      ).rejects.toThrow('symbolic link')
    }
  })

  test('restores empty database and storage directories', async () => {
    const sourceProject = await temporaryProject('supacloud-lite-snapshot-empty-source-')
    const sourcePaths = resolveProjectPaths({ projectDir: sourceProject })
    await ensureProjectSecrets(sourcePaths)
    await mkdir(sourcePaths.dataDir!, { recursive: true })
    await mkdir(sourcePaths.storageDir, { recursive: true })
    const archivePath = join(sourceProject, 'empty.tar.gz')
    await createSnapshot({ paths: sourcePaths, packageVersion: 'test-version', storageBackend: 'fs', output: archivePath })

    const targetProject = await temporaryProject('supacloud-lite-snapshot-empty-target-')
    const targetPaths = resolveProjectPaths({ projectDir: targetProject })
    await restoreSnapshot({ paths: targetPaths, storageBackend: 'fs', input: archivePath })
    expect(await readdir(targetPaths.dataDir!)).toEqual([])
    expect(await readdir(targetPaths.storageDir)).toEqual([])
  })

  test('exposes snapshot and upgrade through the CLI', async () => {
    const projectDir = await temporaryProject('supacloud-lite-snapshot-cli-')
    await mkdir(join(projectDir, 'supabase', 'migrations'), { recursive: true })
    await writeFile(
      join(projectDir, 'supabase', 'migrations', '20260728000000_snapshot_cli.sql'),
      'create table public.snapshot_cli (id bigint primary key);\n',
    )
    const archivePath = join(projectDir, 'manual.tar.gz')

    const created = await runCli(['snapshot', 'create', '--project-dir', projectDir, '--output', archivePath])
    expect(created).toContain(`Snapshot created: ${archivePath}`)

    const upgraded = await runCli(['upgrade', '--project-dir', projectDir, '--output', join(projectDir, 'upgrade.tar.gz')])
    expect(upgraded).toContain('Pre-upgrade snapshot:')
    expect(upgraded).toContain('Upgrade complete')

    const status = await runCli(['status', '--project-dir', projectDir])
    expect(status).toContain('20260728000000')

    const lockPath = `${resolveProjectPaths({ projectDir }).dataDir!}.supacloud-lite.lock`
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runCli(['status', '--project-dir', projectDir])).toContain('20260728000000')
  }, 60_000)

  test('preserves status output larger than a pipe buffer', async () => {
    const projectDir = await temporaryProject('supacloud-lite-status-output-')
    const project = await createProjectBackend({
      projectDir,
      applyMigrations: false,
      includeFunctions: false,
      includeWebhooks: false,
      startRuntimeServices: false,
      log: () => {},
    })
    const migrations = Array.from({ length: 400 }, (_, index) => ({
      version: `2${String(index).padStart(13, '0')}`,
      name: `status_${String(index).padStart(4, '0')}_${'x'.repeat(180)}`,
    }))

    try {
      const values = migrations
        .map(({ version, name }) => `('${version}', '${name}', ARRAY[]::text[])`)
        .join(',\n')
      await project.backend.db.exec(
        `insert into supabase_migrations.schema_migrations (version, name, statements) values ${values}`
      )
    } finally {
      await project.backend.close()
    }

    const status = await runCli(['status', '--project-dir', projectDir])
    expect(new TextEncoder().encode(status).byteLength).toBeGreaterThan(64 * 1024)
    expect(status).toContain(migrations.at(-1)!.version)
  }, 60_000)
})

async function temporaryProject(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function runCli(args: string[]): Promise<string> {
  if (process.platform === 'win32') return runWindowsCli(args)
  const processHandle = Bun.spawn(cliSpawnOptions(args))
  return await withWindowsSubprocessRef(async () => {
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`CLI failed (${exitCode}): ${stderr || stdout}`)
    return stdout
  })
}

function runWindowsCli(args: string[]): string {
  const completed = Bun.spawnSync({
    ...cliSpawnOptions(args),
    timeout: WINDOWS_CLI_TIMEOUT_MS,
    maxBuffer: WINDOWS_CLI_MAX_BUFFER_BYTES,
  })
  const stdout = completed.stdout.toString('utf8')
  const stderr = completed.stderr.toString('utf8')
  if (completed.exitedDueToTimeout) {
    throw new Error(`CLI timed out after ${WINDOWS_CLI_TIMEOUT_MS}ms: ${stderr || stdout}`)
  }
  if (completed.exitedDueToMaxBuffer) throw new Error(`CLI output exceeded ${WINDOWS_CLI_MAX_BUFFER_BYTES} bytes`)
  if (!completed.success) throw new Error(`CLI failed (${completed.exitCode}): ${stderr || stdout}`)
  return stdout
}

function cliSpawnOptions(args: string[]) {
  return {
    cmd: [process.execPath, 'run', join(import.meta.dir, '..', 'src', 'cli.ts'), ...args],
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: process.env,
  }
}
