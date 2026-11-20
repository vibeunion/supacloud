import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleFunction, remoteUrlSpecifier } from '../src/runtime/node/bundle-function.js'

test('removes its isolated output directory when bundling fails', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-failure-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const bundleName = `failure-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  try {
    await writeFile(entryPath, `import './missing-module.ts'\n`)
    await expect(bundleFunction(entryPath, bundleName)).rejects.toThrow()
    expect(existsSync(outputDirectory)).toBe(false)
  } finally {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})

test('resolves npm: specifiers locally instead of rewriting them to a CDN URL', () => {
  expect(remoteUrlSpecifier('npm:zod@3.23.8')).toBeNull()
  expect(remoteUrlSpecifier('./local.ts')).toBeNull()
  expect(remoteUrlSpecifier('https://example.com/module.ts')).toBe('https://example.com/module.ts')
})

test('names the install command when an npm: import cannot be resolved', async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'supacloud-lite-bundle-npm-'))
  const entryPath = join(fixtureDirectory, 'index.ts')
  const bundleName = `npm-${crypto.randomUUID()}`
  const outputDirectory = join(tmpdir(), 'supacloud-lite-fn-bundle', bundleName)
  try {
    await writeFile(entryPath, "import missing from 'npm:@supacloud/definitely-not-published'\nexport default missing\n")
    await expect(bundleFunction(entryPath, bundleName)).rejects.toThrow(
      /bun add @supacloud\/definitely-not-published/,
    )
    expect(existsSync(outputDirectory)).toBe(false)
  } finally {
    await Promise.all([
      rm(fixtureDirectory, { recursive: true, force: true }),
      rm(outputDirectory, { recursive: true, force: true }),
    ])
  }
})
