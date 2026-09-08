import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProjectServer } from '../src/project-runtime.js'
import { compileProject } from '@supacloud/compiler'
import { initializeAppProject } from '../../cli/src/shared/tools/app-starter.js'
import { readJson } from './support/contracts.js'

test('current generated starter runs through Lite bundling, routes, contracts and command governance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-app-contract-'))
  const project = join(root, 'project')
  let running: Awaited<ReturnType<typeof startProjectServer>> | undefined
  try {
    await initializeAppProject({ root: project, name: 'lite-compatibility' })
    await symlink(join(import.meta.dir, '../node_modules'), join(project, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const result = await compileProject({
      rootDir: join(project, 'src'), outDir: join(project, 'generated'),
      graphql: { schema: join(project, 'graphql/schema.graphql') },
      commandCapabilities: { permission: true, audit: true, transaction: true, idempotency: true },
    })
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    for (const name of ['api', 'denied']) {
      await mkdir(join(project, `supabase/functions/${name}`), { recursive: true })
      await writeFile(join(project, `supabase/functions/${name}/index.ts`), `
        import { createMemorySandbox, validatedJsonResponse } from '@supacloud/elysia';
        import { createCompiledModules } from '../../../generated/application';
        const sandbox = createMemorySandbox({
          modules: createCompiledModules(), identity: { authenticated: true, subject: 'local-demo' },
          memoryGovernance: true,
        });
        ${name === 'api' ? `sandbox.policy.grant('local-demo', 'review.approve');` : ''}
        sandbox.db.set('reviews', 'demo', { state: 'draft', version: 1 });
        sandbox.app.get('/native', () => validatedJsonResponse(
          (value: unknown): value is { ok: boolean } => typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean',
          { ok: true }
        ));
        export default sandbox.app;
      `)
    }
    await writeFile(join(project, 'supabase/config.toml'), `
[lite]
runtime_mode = "strict"
[lite.graphql]
enabled = false
[functions.api]
framework = "elysia"
verify_jwt = false
[functions.denied]
framework = "elysia"
verify_jwt = false
`)
    running = await startProjectServer({ projectDir: project, memory: true, port: 0, log: () => {} })
    const base = `${running.url}/functions/v1`
    expect(await readJson(await fetch(`${base}/api/reviews/health`))).toEqual({ ok: true })
    expect(await readJson(await fetch(`${base}/api/native`))).toEqual({ ok: true })
    const approve = (body: unknown, key: string, fn = 'api') => fetch(`${base}/${fn}/reviews/demo/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
    })
    expect((await approve({ expectedVersion: 'invalid' }, 'invalid')).status).toBe(422)
    expect((await approve({ expectedVersion: 1 }, 'denied', 'denied')).status).toBe(403)
    const first = await approve({ expectedVersion: 1 }, 'once')
    expect(first.status).toBe(200)
    expect(await readJson(first)).toEqual({ state: 'approved', version: 2 })
    const replay = await approve({ expectedVersion: 1 }, 'once')
    expect(replay.status).toBe(200)
    expect(await readJson(replay)).toEqual({ state: 'approved', version: 2 })
    expect((await approve({ expectedVersion: 1 }, 'new-key')).status).toBe(409)
  } finally {
    try { await running?.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
}, 120_000)
