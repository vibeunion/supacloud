import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../src/runtime/index.js'
import { strictFunction } from '../src/runtime/functions/profile.js'
import { loadProjectConfig } from '../src/runtime/node/load-config.js'
import { loadFunctions } from '../src/runtime/node/load-functions.js'

test('strict defaults and invalid limits are deterministic', () => {
  const entry = strictFunction({ handler: () => Response.json({ ok: true }) })
  expect(entry.limits).toEqual({ timeoutMs: 900_000, maxRequestBodyBytes: 31457280, maxResponseBodyBytes: 31457280, waitUntilTimeoutMs: 300_000 })
  expect(entry.capabilities?.background).toBe(false)
  for (const value of [-1, 0, 1.2, Number.NaN, 900_001]) {
    expect(() => strictFunction({ handler: () => new Response(), limits: { timeoutMs: value } })).toThrow()
  }
})

test('strict mode denies undeclared background work and retains explicit opt-in', async () => {
  const backend = await createBackend({
    runtimeMode: 'strict', startRuntimeServices: false,
    functions: {
      denied: () => { (globalThis as any).EdgeRuntime.waitUntil(Promise.resolve()); return new Response('ok') },
      allowed: { capabilities: { background: true }, handler: () => {
        (globalThis as any).EdgeRuntime.waitUntil(Promise.resolve()); return new Response('ok')
      } },
    },
  })
  try {
    const request = (name: string) => backend.fetch(`http://local/functions/v1/${name}`, { headers: { apikey: backend.anonKey } })
    expect((await request('denied')).status).toBe(500)
    expect((await request('allowed')).status).toBe(200)
    expect(() => backend.functions.register('bad', { handler: () => new Response(), limits: { timeoutMs: -1 } })).toThrow('invalid')
  } finally { await backend.close() }
})

test('strict config and broken function imports fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-strict-'))
  try {
    await mkdir(join(root, 'supabase/functions/api'), { recursive: true })
    for (const value of ['-1', '3.5', '"10ms"']) {
      await writeFile(join(root, 'supabase/config.toml'), `[lite]\nruntime_mode = "strict"\n[functions.api]\ntimeout_ms = ${value}\n`)
      expect(() => loadProjectConfig(root)).toThrow('invalid strict function limit')
    }
    await writeFile(join(root, 'supabase/functions/api/index.ts'), 'throw new Error("broken fixture"); export default () => new Response();')
    await expect(loadFunctions(root, {}, 'strict')).rejects.toThrow('failed to load strict function')
    await expect(loadFunctions(root, { missing: {} }, 'strict')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
