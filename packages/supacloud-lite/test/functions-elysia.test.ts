import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startProjectServer } from '../src/project-runtime.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('loads an Elysia function with framework profile and routes function-local paths', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-elysia-'))
  // A real project has node_modules at its root; link ours so the bundled
  // function can resolve the bare `elysia` specifier like a user project would.
  await symlink(join(packageRoot, 'node_modules'), join(projectDir, 'node_modules'))
  await mkdir(join(projectDir, 'supabase', 'functions', 'api'), { recursive: true })
  await writeFile(
    join(projectDir, 'supabase', 'config.toml'),
    `[functions.api]\nframework = "elysia"\nverify_jwt = false\n`
  )
  await writeFile(
    join(projectDir, 'supabase', 'functions', 'api', 'index.ts'),
    `import { Elysia } from 'elysia'\n` +
      `export default new Elysia()\n` +
      `  .get('/', () => ({ root: true }))\n` +
      `  .get('/cases/:id', ({ params }) => ({ id: params.id }))\n` +
      `  .post('/cases', ({ body }) => ({ created: body }))\n`
  )

  try {
    const running = await startProjectServer({ projectDir, port: 0, log: () => {} })
    try {
      const root = await fetch(`${running.url}/functions/v1/api`)
      expect(root.status).toBe(200)
      expect(await root.json()).toEqual({ root: true })

      const nested = await fetch(`${running.url}/functions/v1/api/cases/42`)
      expect(nested.status).toBe(200)
      expect(await nested.json()).toEqual({ id: '42' })

      const posted = await fetch(`${running.url}/functions/v1/api/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'hello' }),
      })
      expect(posted.status).toBe(200)
      expect(await posted.json()).toEqual({ created: { title: 'hello' } })
    } finally {
      await running.close()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)
