import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeJwt } from '../src/vendor/tinbase/jwt.js'
import { ensureProjectSecrets, mintProjectKeys, resolveProjectPaths } from '../src/project-runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('project runtime', () => {
  test('creates one protected secret set across concurrent callers', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-secrets-'))
    temporaryDirectories.push(projectDir)
    const paths = resolveProjectPaths({ projectDir })

    const [first, second] = await Promise.all([ensureProjectSecrets(paths), ensureProjectSecrets(paths)])
    expect(second).toEqual(first)
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
})
