import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProjectServer } from '../src/project-runtime.js'

test('reloads Deno.serve functions after an in-process restart', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-function-restart-'))
  await mkdir(join(projectDir, 'supabase', 'functions', 'restart'), { recursive: true })
  await writeFile(
    join(projectDir, 'supabase', 'functions', 'restart', 'index.ts'),
    `Deno.serve(() => Response.json({ restarted: true }))\n`
  )

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const running = await startProjectServer({ projectDir, port: 0, log: () => {} })
      const response = await fetch(`${running.url}/functions/v1/restart`, {
        headers: { apikey: running.backend.anonKey, authorization: `Bearer ${running.backend.anonKey}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ restarted: true })
      await running.close()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)
