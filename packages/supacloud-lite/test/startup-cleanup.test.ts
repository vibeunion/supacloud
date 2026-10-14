import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'

test('releases the database when bucket initialization fails', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-startup-cleanup-'))
  const dataDir = join(projectDir, 'db')
  try {
    await expect(
      createBackend({
        dataDir,
        buckets: [{ id: '.supacloud-lite', public: false, fileSizeLimit: null, allowedMimeTypes: null }],
        startRuntimeServices: false,
        log: () => {},
      })
    ).rejects.toThrow('reserved for internal object versions')

    const backend = await createBackend({
      dataDir,
      startRuntimeServices: false,
      log: () => {},
    })
    try {
      expect((await backend.fetch('http://local/health')).status).toBe(200)
    } finally {
      await backend.close()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 30_000)
