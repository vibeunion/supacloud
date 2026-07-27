import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { decodeJwt } from '../src/vendor/tinbase/jwt.js'
import { loadSupabaseProject } from '../src/vendor/tinbase/node/project.js'
import {
  createProjectBackend,
  assertResetPathsSafe,
  ensureProjectSecrets,
  mintProjectKeys,
  resolveProjectPaths,
} from '../src/project-runtime.js'
import type { StorageDriver } from '../src/vendor/tinbase/types.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('project runtime', () => {
  test('creates one protected secret set across concurrent callers', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-secrets-'))
    temporaryDirectories.push(projectDir)
    const paths = resolveProjectPaths({ projectDir })

    const secrets = await Promise.all(Array.from({ length: 8 }, () => ensureProjectSecrets(paths)))
    const first = secrets[0]!
    expect(secrets.every((candidate) => candidate.jwtSecret === first.jwtSecret)).toBe(true)
    expect(secrets.every((candidate) => candidate.vaultKey === first.vaultKey)).toBe(true)
    expect(first.jwtSecret.length).toBeGreaterThanOrEqual(64)
    expect(first.vaultKey.length).toBeGreaterThanOrEqual(64)
    expect((await stat(paths.secretsFile)).mode & 0o777).toBe(0o600)
  })

  test('mints fixed local-project anon and service role keys', async () => {
    const keys = await mintProjectKeys('x'.repeat(64))
    expect(decodeJwt(keys.anonKey)).toMatchObject({ ref: 'local', role: 'anon' })
    expect(decodeJwt(keys.serviceRoleKey)).toMatchObject({ ref: 'local', role: 'service_role' })
  })

  test('resolves all default state paths under the project', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-paths-'))
    temporaryDirectories.push(projectDir)
    const paths = resolveProjectPaths({ projectDir })
    expect(paths.stateDir).toBe(join(projectDir, '.supacloud-lite'))
    expect(paths.dataDir).toBe(join(projectDir, '.supacloud-lite', 'db'))
    expect(paths.storageDir).toBe(join(projectDir, '.supacloud-lite', 'storage'))
  })

  test('refuses destructive reset targets outside the state directory', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-reset-paths-'))
    temporaryDirectories.push(projectDir)
    const safePaths = resolveProjectPaths({ projectDir })
    await ensureProjectSecrets(safePaths)
    await expect(assertResetPathsSafe(safePaths)).resolves.toBeUndefined()

    const unsafePaths = resolveProjectPaths({ projectDir, dataDir: join(projectDir, 'database') })
    await expect(assertResetPathsSafe(unsafePaths)).rejects.toThrow('outside the state directory')

    const externalDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-reset-external-'))
    temporaryDirectories.push(externalDir)
    await symlink(externalDir, join(safePaths.stateDir, 'linked'))
    await expect(
      assertResetPathsSafe({ ...safePaths, storageDir: join(safePaths.stateDir, 'linked', 'storage') })
    ).rejects.toThrow('symbolic link')

    const root = parse(projectDir).root
    await expect(
      assertResetPathsSafe({ ...safePaths, stateDir: root, dataDir: join(root, 'db'), storageDir: join(root, 'storage') })
    ).rejects.toThrow('filesystem root')
  })

  test('does not mount the default email inbox on network-exposed hosts', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-exposed-inbox-'))
    temporaryDirectories.push(projectDir)
    const project = await createProjectBackend({
      projectDir,
      host: '0.0.0.0',
      includeFunctions: false,
      includeWebhooks: false,
    })
    try {
      expect(project.backend.inbox).toBeNull()
      const response = await project.backend.fetch(new Request('http://127.0.0.1/inbox/api/messages'))
      expect(response.status).toBe(401)
    } finally {
      await project.backend.close()
    }
  })

  test('selects explicit and custom storage backends', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-backend-'))
    temporaryDirectories.push(projectDir)
    const memoryProject = await createProjectBackend({
      projectDir,
      storageBackend: 'memory',
      includeFunctions: false,
      includeWebhooks: false,
    })
    try {
      expect(memoryProject.storageBackend).toBe('memory')
    } finally {
      await memoryProject.backend.close()
    }

    const driver: StorageDriver = {
      async put() {},
      async get() { return null },
      async delete() {},
      async deleteMany() {},
    }
    const customProject = await createProjectBackend({
      projectDir,
      storageDriver: driver,
      includeFunctions: false,
      includeWebhooks: false,
    })
    try {
      expect(customProject.storageBackend).toBe('custom')
    } finally {
      await customProject.backend.close()
    }
  })

  test('rejects unknown storage backends', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-storage-invalid-'))
    temporaryDirectories.push(projectDir)
    await expect(
      createProjectBackend({
        projectDir,
        storageBackend: 'unknown' as never,
        includeFunctions: false,
        includeWebhooks: false,
      })
    ).rejects.toThrow('unsupported SUPACLOUD_LITE_STORAGE_BACKEND')
  })

  test('locks persistent PGlite data directories and releases the lock on idempotent close', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-lock-'))
    temporaryDirectories.push(projectDir)
    const first = await createProjectBackend({ projectDir, includeFunctions: false, includeWebhooks: false })
    await expect(
      createProjectBackend({ projectDir, includeFunctions: false, includeWebhooks: false })
    ).rejects.toThrow('already in use')
    await Promise.all([first.backend.close(), first.backend.close()])
    const reopened = await createProjectBackend({ projectDir, includeFunctions: false, includeWebhooks: false })
    await reopened.backend.close()

    const paths = resolveProjectPaths({ projectDir })
    await writeFile(`${paths.dataDir}.supacloud-lite.lock`, JSON.stringify({ pid: 999_999, nonce: 'stale' }))
    await expect(
      createProjectBackend({ projectDir, includeFunctions: false, includeWebhooks: false })
    ).rejects.toThrow('remove the lock manually')
  })

  test('expands seed globs deterministically and surfaces migration directory errors', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-project-loader-'))
    temporaryDirectories.push(projectDir)
    await mkdir(join(projectDir, 'supabase', 'seeds'), { recursive: true })
    await writeFile(join(projectDir, 'supabase', 'seeds', '02.sql'), "insert into test values ('second');\n")
    await writeFile(join(projectDir, 'supabase', 'seeds', '01.sql'), "insert into test values ('first');\n")
    const loaded = await loadSupabaseProject(projectDir, { paths: ['seeds/*.sql'] })
    expect(loaded.seedSql).toBe("insert into test values ('first');\n\ninsert into test values ('second');\n")

    await writeFile(join(projectDir, 'supabase', 'migrations'), 'not a directory')
    await expect(loadSupabaseProject(projectDir)).rejects.toThrow()
  })
})
