import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeEngine, nativePostgresMajor, NATIVE_POSTGRES_MAJOR } from '../src/runtime/node/native/engine.js'
import { createSnapshot, restoreSnapshot } from '../src/snapshot.js'
import { resolveProjectPaths } from '../src/project-runtime.js'
import assert from 'node:assert/strict'

const posixTest = process.platform === 'win32' ? test.skip : test
posixTest('PostgreSQL 18 defaults and selected installations enforce snapshot major compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-native-install-'))
  try {
    const installation = join(root, 'postgres18')
    await mkdir(join(installation, 'bin'), { recursive: true })
    await writeFile(join(installation, 'bin/postgres'), '#!/bin/sh\nprintf "postgres (PostgreSQL) 18.4\\n"\n', { mode: 0o755 })
    await writeFile(join(installation, 'bin/initdb'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(NATIVE_POSTGRES_MAJOR).toBe('18')
    expect(nativePostgresMajor(installation)).toBe('18')
    const source = resolveProjectPaths({ projectDir: join(root, 'source'), engine: 'native' })
    assert(source.dataDir)
    await mkdir(source.dataDir, { recursive: true })
    await writeFile(join(source.dataDir, 'PG_VERSION'), '18\n')
    await writeFile(source.secretsFile, JSON.stringify({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), createdAt: 'fixture' }))
    const snapshot = join(root, 'backup.tar.gz')
    await createSnapshot({ paths: source, packageVersion: 'fixture', storageBackend: 'memory', output: snapshot })
    const target = resolveProjectPaths({ projectDir: join(root, 'target'), engine: 'native' })
    assert(target.dataDir)
    await mkdir(target.projectDir, { recursive: true })
    await restoreSnapshot({ paths: target, storageBackend: 'memory', input: snapshot })
    expect(await readFile(join(target.dataDir, 'PG_VERSION'), 'utf8')).toBe('18\n')

    await writeFile(join(source.dataDir, 'PG_VERSION'), '17\n')
    const legacySnapshot = join(root, 'legacy17.tar.gz')
    await createSnapshot({ paths: source, packageVersion: 'fixture', storageBackend: 'memory', output: legacySnapshot })
    const legacyTarget = resolveProjectPaths({ projectDir: join(root, 'legacy-target'), engine: 'native' })
    assert(legacyTarget.dataDir)
    await mkdir(legacyTarget.projectDir, { recursive: true })
    await expect(restoreSnapshot({ paths: legacyTarget, storageBackend: 'memory', input: legacySnapshot })).rejects.toThrow('snapshot major is 17')
    const legacyInstallation = join(root, 'postgres17')
    await mkdir(join(legacyInstallation, 'bin'), { recursive: true })
    await writeFile(join(legacyInstallation, 'bin/postgres'), '#!/bin/sh\nprintf "postgres (PostgreSQL) 17.7\\n"\n', { mode: 0o755 })
    await restoreSnapshot({ paths: legacyTarget, storageBackend: 'memory', input: legacySnapshot, postgresDir: legacyInstallation })
    expect(await readFile(join(legacyTarget.dataDir, 'PG_VERSION'), 'utf8')).toBe('17\n')
    await expect(createNativeEngine({ dataDir: source.dataDir, installDir: installation })).rejects.toThrow('major version does not match')
    expect(await readdir(source.dataDir)).toEqual(['PG_VERSION'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
