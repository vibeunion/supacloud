import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildLiteAgentHandoff,
  evaluateRlsCompletion,
  liteProjectUrl,
  serializeLiteAgentHandoff,
} from '../src/agent-contract.js'
import { mintProjectApiKeys } from '../src/runtime/jwt.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')

test('handoff JSON contains only the project URL, anon key, and next commands', async () => {
  const keys = await mintProjectApiKeys('agent-contract-test-secret-32chars-min')
  const handoff = buildLiteAgentHandoff({
    url: 'http://127.0.0.1:54321',
    anonKey: keys.anonKey,
    projectDir: '/work/orders',
  })
  expect(Object.keys(handoff)).toEqual(['url', 'anon_key', 'next'])
  expect(handoff.url).toBe('http://127.0.0.1:54321')
  expect(handoff.anon_key).toBe(keys.anonKey)
  expect(handoff.next).toEqual([
    'supacloud-lite migrate --project-dir /work/orders',
    'supacloud-lite complete --project-dir /work/orders --module-file supabase/db/modules.ts',
  ])
  const serialized = serializeLiteAgentHandoff(handoff)
  expect(serialized).not.toContain(keys.serviceRoleKey)
  expect(serialized).not.toContain('service_role')
  expect(serialized).not.toContain('--service-role')
  expect(() => buildLiteAgentHandoff({
    url: 'http://127.0.0.1:54321',
    anonKey: keys.serviceRoleKey,
    projectDir: '/work/orders',
  })).toThrow(/non-anon/)
  expect(liteProjectUrl({ host: '0.0.0.0', port: 54321 })).toBe('http://127.0.0.1:54321')
  expect(() => liteProjectUrl({ host: '127.0.0.1', port: 0 })).toThrow(/concrete/)
})

test('RLS completion is not done when the existing reconcile is skipped or finds rls-disabled', () => {
  expect(evaluateRlsCompletion({ executed: false, ok: true, ownedTableCount: 2, rlsDisabled: [] })).toMatchObject({
    done: false,
    rls_checks: 'skipped',
    skipped_is_done: false,
  })
  expect(evaluateRlsCompletion({ executed: true, ok: true, ownedTableCount: 0, rlsDisabled: [] })).toMatchObject({
    done: false,
    rls_checks: 'skipped',
  })
  expect(evaluateRlsCompletion({
    executed: true,
    ok: false,
    ownedTableCount: 1,
    rlsDisabled: ['public.orders'],
  })).toMatchObject({
    done: false,
    rls_checks: 'ran',
    rls_disabled: ['public.orders'],
  })
  expect(evaluateRlsCompletion({ executed: true, ok: true, ownedTableCount: 1, rlsDisabled: [] })).toEqual({
    done: true,
    rls_checks: 'ran',
    skipped_is_done: false,
    rls_disabled: [],
  })
})

test('CLI handoff and keys JSON stay on the anon key', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-agent-handoff-'))
  try {
    const handoff = await runCli(projectDir, ['handoff', '--port', '54321'])
    expect(handoff.exitCode).toBe(0)
    expect(handoff.stderr).toBe('')
    const payload = JSON.parse(handoff.stdout) as { url: string; anon_key: string; next: string[] }
    expect(Object.keys(JSON.parse(handoff.stdout)).sort()).toEqual(['anon_key', 'next', 'url'])
    expect(payload.url).toBe('http://127.0.0.1:54321')
    expect(jwtRole(payload.anon_key)).toBe('anon')
    expect(payload.next.some((command) => command.startsWith('supacloud-lite complete '))).toBe(true)
    expect(handoff.stdout).not.toContain('service_role')

    const privileged = await runCli(projectDir, ['keys', '--service-role'])
    expect(privileged.exitCode).toBe(0)
    const serviceRoleKey = privileged.stdout.match(/service_role key:\n([^\n]+)/)?.[1]
    expect(serviceRoleKey).toBeTruthy()
    expect(handoff.stdout).not.toContain(serviceRoleKey!)

    const jsonKeys = await runCli(projectDir, ['keys', '--json', '--port', '54321'])
    expect(jsonKeys.exitCode).toBe(0)
    expect(JSON.parse(jsonKeys.stdout).anon_key).toBe(payload.anon_key)
    expect(jsonKeys.stdout).not.toContain(serviceRoleKey!)

    const refused = await runCli(projectDir, ['keys', '--json', '--service-role'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout).not.toContain(serviceRoleKey!)
    expect(refused.stderr).not.toContain(serviceRoleKey!)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('complete fails closed when the module manifest is missing', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-agent-complete-'))
  try {
    const result = await runCli(projectDir, ['complete', '--json'])
    expect(result.exitCode).not.toBe(0)
    const completion = JSON.parse(result.stdout) as { done: boolean; rls_checks: string }
    expect(completion.done).toBe(false)
    expect(completion.rls_checks).toBe('skipped')
    expect(result.stdout).not.toContain('anon_key')
    expect(result.stdout).not.toContain('service_role')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('complete reports the existing rls-disabled reconcile', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-agent-rls-'))
  try {
    await mkdir(join(projectDir, 'supabase/migrations'), { recursive: true })
    await mkdir(join(projectDir, 'supabase/db'), { recursive: true })
    await writeFile(join(projectDir, 'supabase/migrations/20260101000000_orders.sql'), 'create table public.orders (id int primary key);\n')
    await writeFile(join(projectDir, 'supabase/db/modules.ts'), `export default {
  name: 'orders',
  tables: ['public.orders'],
  policies: [],
  functions: [],
  triggers: [],
  grants: [],
}
`)
    const migrated = await runCli(projectDir, ['migrate'])
    expect(migrated.exitCode).toBe(0)
    const blocked = await runCli(projectDir, ['complete', '--json'])
    expect(blocked.exitCode).not.toBe(0)
    const completion = JSON.parse(blocked.stdout) as { done: boolean; rls_checks: string; rls_disabled: string[] }
    expect(completion.done).toBe(false)
    expect(completion.rls_checks).toBe('ran')
    expect(completion.rls_disabled).toContain('public.orders')
    expect(blocked.stdout).not.toContain('service_role')

    await writeFile(
      join(projectDir, 'supabase/migrations/20260101000100_orders_rls.sql'),
      'alter table public.orders enable row level security;\n',
    )
    const remigrated = await runCli(projectDir, ['migrate'])
    expect(remigrated.exitCode).toBe(0)
    const passed = await runCli(projectDir, ['complete', '--json'])
    expect(passed.exitCode).toBe(0)
    expect(JSON.parse(passed.stdout)).toMatchObject({ done: true, rls_checks: 'ran', skipped_is_done: false, rls_disabled: [] })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)

test('start --json prints one handoff and no service_role key', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-agent-start-'))
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const server = Bun.spawn({
    cmd: [bunExecutable, cliPath, 'start', '--json', '--memory', '--port', '0', '--project-dir', projectDir],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: withoutProjectRuntimeOverrides(),
  })
  const stderrPromise = new Response(server.stderr).text()
  let stdout = ''
  try {
    stdout = await readLine(server.stdout)
    const payload = JSON.parse(stdout) as { url: string; anon_key: string; next: string[] }
    expect(Object.keys(payload).sort()).toEqual(['anon_key', 'next', 'url'])
    expect(payload.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(jwtRole(payload.anon_key)).toBe('anon')
    expect(payload.next.some((command) => command.includes(' complete '))).toBe(true)
    expect(stdout).not.toContain('service_role')
  } finally {
    try { server.kill() } catch { /* already exited */ }
    await server.exited
  }
  const stderr = await stderrPromise
  expect(`${stdout}\n${stderr}`).not.toContain('service_role key:')
  await rm(projectDir, { recursive: true, force: true })
}, 90_000)

async function runCli(projectDir: string, args: string[]) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const cliProcess = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...args, '--project-dir', projectDir],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: withoutProjectRuntimeOverrides(),
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    cliProcess.exited,
    new Response(cliProcess.stdout).text(),
    new Response(cliProcess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const newline = buffered.indexOf('\n')
    if (newline >= 0) {
      reader.releaseLock()
      return buffered.slice(0, newline)
    }
  }
  reader.releaseLock()
  throw new Error(`timed out waiting for the agent handoff:\n${buffered}`)
}

function jwtRole(token: string): unknown {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('missing JWT payload')
  return (JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { role?: unknown }).role
}

function withoutProjectRuntimeOverrides(): Record<string, string | undefined> {
  const environment = { ...process.env }
  delete environment.SUPACLOUD_LITE_JWT_SECRET
  delete environment.SUPACLOUD_LITE_VAULT_KEY
  delete environment.SUPACLOUD_LITE_STATE_DIR
  delete environment.SUPACLOUD_LITE_DATA_DIR
  delete environment.SUPACLOUD_LITE_STORAGE_DIR
  delete environment.SUPACLOUD_LITE_API_URL
  delete environment.SUPACLOUD_LITE_HOST
  delete environment.SUPACLOUD_LITE_PORT
  delete environment.PORT
  return environment
}
