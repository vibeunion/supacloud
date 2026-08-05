import { expect, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STANDALONE_PGLITE_ASSETS,
  type StandalonePgliteAssets,
} from '../src/standalone-assets-protocol.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

const emptyWasmModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))

test('preserves standalone extension preparation errors and releases the data lock', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-pglite-assets-'))
  const dataDir = join(projectDir, 'db')
  const lockPath = `${dataDir}.supacloud-lite.lock`
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>
  const previousAssets = globals[STANDALONE_PGLITE_ASSETS]
  const preparationError = new Error('standalone extension bundle permission denied')
  globals[STANDALONE_PGLITE_ASSETS] = {
    pgliteWasmModule: emptyWasmModule,
    initdbWasmModule: emptyWasmModule,
    fsBundle: new Blob(),
    prepareExtensionBundles: async () => { throw preparationError },
  } satisfies StandalonePgliteAssets

  try {
    await expect(createPgliteEngine(dataDir)).rejects.toBe(preparationError)
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (previousAssets === undefined) delete globals[STANDALONE_PGLITE_ASSETS]
    else globals[STANDALONE_PGLITE_ASSETS] = previousAssets
    await rm(projectDir, { recursive: true, force: true })
  }
})
