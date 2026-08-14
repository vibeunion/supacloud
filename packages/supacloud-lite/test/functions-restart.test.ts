import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProjectServer } from '../src/project-runtime.js'

test('reloads Deno.serve and default fetch-object functions after an in-process restart', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-function-restart-'))
  await mkdir(join(projectDir, 'supabase', 'functions', 'restart'), { recursive: true })
  await mkdir(join(projectDir, 'supabase', 'functions', 'fetch-object'), { recursive: true })
  await writeFile(
    join(projectDir, 'supabase', 'functions', 'restart', 'index.ts'),
    `Deno.serve(() => Response.json({ restarted: true }))\n`
  )
  await writeFile(
    join(projectDir, 'supabase', 'functions', 'fetch-object', 'index.ts'),
    `export default { fetch: () => Response.json({ fetchObject: true }) }\n`
  )

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const running = await startProjectServer({ projectDir, port: 0, log: () => {} })
      const response = await fetch(`${running.url}/functions/v1/restart`, {
        headers: { apikey: running.backend.anonKey, authorization: `Bearer ${running.backend.anonKey}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ restarted: true })

      const fetchObjectResponse = await fetch(`${running.url}/functions/v1/fetch-object`, {
        headers: { apikey: running.backend.anonKey, authorization: `Bearer ${running.backend.anonKey}` },
      })
      expect(fetchObjectResponse.status).toBe(200)
      expect(await fetchObjectResponse.json()).toEqual({ fetchObject: true })
      await running.close()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)
