import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleFunction } from '../src/runtime/node/bundle-function.js'

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
