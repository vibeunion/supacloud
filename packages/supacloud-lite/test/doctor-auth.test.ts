import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { liteCapabilities } from '../src/runtime/node/native/readiness.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

for (const engine of ['pglite', 'native'] as const) {
  test(`capabilities distinguish disabled local Auth on ${engine}`, () => {
    expect(liteCapabilities(engine).identity.local_auth).toEqual({
      status: 'enabled', reason: 'LOCAL_AUTH_ENABLED', verification: 'configuration-only',
    })
    expect(liteCapabilities(engine, undefined, false).identity.local_auth).toEqual({
      status: 'disabled', reason: 'AUTH_DISABLED', verification: 'configuration-only',
    })
  })
}

const scenarios = [
  { name: 'default', config: '', mode: 'local', status: 'enabled', reason: 'LOCAL_AUTH_ENABLED', args: [] },
  { name: 'disabled', config: '[auth]\nenabled = false\n', mode: 'local', status: 'disabled', reason: 'AUTH_DISABLED', args: [] },
  { name: 'external', config: '[lite.identity]\nmodule = "missing-identity.ts"\n', mode: 'external', status: 'disabled', reason: 'EXTERNAL_IDENTITY_CONFIGURED', args: [] },
  { name: 'external and disabled', config: '[auth]\nenabled = false\n[lite.identity]\nmodule = "missing-identity.ts"\n', mode: 'external', status: 'disabled', reason: 'EXTERNAL_IDENTITY_CONFIGURED', args: [] },
  { name: 'CLI external override', config: '', mode: 'external', status: 'disabled', reason: 'EXTERNAL_IDENTITY_CONFIGURED', args: ['--identity-module', 'missing-override.ts'] },
]

for (const scenario of scenarios) {
  test(`doctor describes ${scenario.name} Auth without loading identity or creating state`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'lite-doctor-auth-'))
    roots.push(root)
    await mkdir(join(root, 'supabase'))
    await writeFile(join(root, 'supabase/config.toml'), scenario.config)
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SUPACLOUD_LITE_')))
    for (const json of [true, false]) {
      const process = Bun.spawn([
        Bun.which('bun')!, resolve(import.meta.dir, '../src/cli.ts'), 'doctor',
        '--project-dir', root, '--state-dir', join(root, 'state'),
        ...scenario.args, ...(json ? ['--json'] : []),
      ], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
      const [exit, output, errors] = await Promise.all([
        process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
      ])
      expect(exit).toBe(0)
      expect(errors).toBe('')
      if (json) {
        const report: unknown = JSON.parse(output)
        expect(report).toMatchObject({
          identity: {
            mode: scenario.mode,
            verification: scenario.mode === 'local' ? 'built-in' : 'unverified',
            local_auth: {
              status: scenario.status, reason: scenario.reason, verification: 'configuration-only',
            },
          },
        })
      } else {
        expect(output).toContain(`local_auth: ${scenario.status} (${scenario.reason}, configuration-only)`)
      }
      expect(output).not.toContain('missing-identity.ts')
      expect(output).not.toContain('missing-override.ts')
      expect(await readdir(root)).toEqual(['supabase'])
    }
  }, 20_000)
}
