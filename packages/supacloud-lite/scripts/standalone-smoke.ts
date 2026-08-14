import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { executeBufferedCommand, withWindowsSubprocessRef } from './subprocess.js'

const packageDir = resolve(import.meta.dir, '..')
const binary = resolveStandaloneBinary()
const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-standalone-'))
const emptyPath = await mkdtemp(join(tmpdir(), 'supacloud-lite-empty-path-'))
const migrationDir = join(projectDir, 'supabase', 'migrations')
const functionDir = join(projectDir, 'supabase', 'functions', 'ping')
const fetchObjectFunctionDir = join(projectDir, 'supabase', 'functions', 'fetch-object')
const v1 = '20260729000000'
const v2 = '20260729000001'
const commandTimeoutMs = 120_000

try {
  await access(binary)
  await mkdir(migrationDir, { recursive: true })
  await mkdir(functionDir, { recursive: true })
  await mkdir(fetchObjectFunctionDir, { recursive: true })
  await writeFile(join(projectDir, 'supabase', 'config.toml'), `
[auth]
enabled = false

[db.seed]
enabled = true
sql_paths = ["./seed.sql"]

[functions.ping]
verify_jwt = false

[functions.fetch-object]
verify_jwt = false
`)
  await writeFile(join(migrationDir, `${v1}_create_upgrade_probe.sql`), `
create table public.upgrade_probe (
  id bigint primary key,
  body text not null
);
grant usage on schema public to anon, authenticated, service_role;
grant select on public.upgrade_probe to anon, authenticated, service_role;
select uuid_generate_v4();
select crypt('secret', gen_salt('bf'));
select 'standalone'::citext;
select similarity('standalone', 'standalone');
select 'SupaCloud.Lite'::ltree;
select 'runtime=>standalone'::hstore;
select levenshtein('lite', 'lite');
`)
  await writeFile(join(projectDir, 'supabase', 'seed.sql'), `
insert into public.upgrade_probe (id, body)
values (1, 'preserved-v1')
on conflict (id) do update set body = excluded.body;
`)
  await writeFile(join(functionDir, 'index.ts'), `
Deno.serve(() => Response.json({ ok: true, runtime: 'standalone' }))
`)
  await writeFile(join(fetchObjectFunctionDir, 'index.ts'), `
export default {
  fetch: () => Response.json({ ok: true, runtime: 'fetch-object' })
}
`)

  const isolatedEnvironment = withoutRuntimePath(emptyPath)
  const version = (
    await runCommand('version', [binary, 'version'], projectDir, isolatedEnvironment)
  ).trim()
  assert(version === packageJson.version, `unexpected standalone version: ${version}`)

  await runCommand('migrate v1', [binary, 'migrate', '--project-dir', projectDir], projectDir, isolatedEnvironment)
  const statusV1 = await runCommand(
    'status v1',
    [binary, 'status', '--project-dir', projectDir],
    projectDir,
    isolatedEnvironment,
  )
  assertMigrationStatus(statusV1, [v1], [v2], 'v1')

  const anonKey = parseAnonKey(
    await runCommand('keys', [binary, 'keys', '--project-dir', projectDir], projectDir, isolatedEnvironment),
  )
  await withServer({ phaseLabel: 'server v1', binary, projectDir, environment: isolatedEnvironment }, async (url) => {
    const health = await fetch(`${url}/health`)
    assert(health.status === 200, `health returned HTTP ${health.status}`)
    assert((await health.json() as { status?: string }).status === 'healthy', 'health payload was not healthy')

    const functionResponse = await fetch(`${url}/functions/v1/ping`, { method: 'POST' })
    assert(functionResponse.status === 200, `function returned HTTP ${functionResponse.status}`)
    const functionBody = await functionResponse.json() as { ok?: boolean; runtime?: string }
    assert(functionBody.ok === true && functionBody.runtime === 'standalone', 'function response was unexpected')

    const fetchObjectResponse = await fetch(`${url}/functions/v1/fetch-object`, { method: 'POST' })
    assert(fetchObjectResponse.status === 200, `fetch-object function returned HTTP ${fetchObjectResponse.status}`)
    const fetchObjectBody = await fetchObjectResponse.json() as { ok?: boolean; runtime?: string }
    assert(
      fetchObjectBody.ok === true && fetchObjectBody.runtime === 'fetch-object',
      'fetch-object function response was unexpected',
    )
  })

  const storageDir = join(projectDir, '.supacloud-lite', 'storage')
  const storageSentinel = join(storageDir, 'upgrade-sentinel.txt')
  await mkdir(storageDir, { recursive: true })
  await writeFile(storageSentinel, 'preserved-storage-v1')
  const secretsBeforeUpgrade = await readFile(join(projectDir, '.supacloud-lite', 'secrets.json'), 'utf8')

  await writeFile(join(migrationDir, `${v2}_add_upgrade_marker.sql`), `
do $$
begin
  if not exists (select 1 from public.upgrade_probe where id = 1 and body = 'preserved-v1') then
    raise exception 'v1 sentinel is missing before upgrade';
  end if;
end $$;
alter table public.upgrade_probe
  add column upgraded boolean not null default true;
`)
  const upgradeOutput = await runCommand(
    'upgrade v2',
    [binary, 'upgrade', '--project-dir', projectDir],
    projectDir,
    isolatedEnvironment,
  )
  const snapshotMarker = 'Pre-upgrade snapshot: '
  const completionMarker = 'Upgrade complete on @supacloud/lite'
  assert(upgradeOutput.indexOf(snapshotMarker) >= 0, 'upgrade did not report its pre-upgrade snapshot')
  assert(upgradeOutput.indexOf(snapshotMarker) < upgradeOutput.indexOf(completionMarker), 'upgrade reported completion before its snapshot')

  const snapshotPath = lineAfter(upgradeOutput, snapshotMarker)
  const snapshotInfo = await stat(snapshotPath)
  assert(snapshotInfo.isFile() && snapshotInfo.size > 0, 'pre-upgrade snapshot is empty')

  const restoredStateDir = join(projectDir, '.restored-v1')
  await runCommand('snapshot restore pre-upgrade', [
    binary,
    'snapshot',
    'restore',
    snapshotPath,
    '--project-dir',
    projectDir,
    '--state-dir',
    restoredStateDir,
  ], projectDir, isolatedEnvironment)
  const restoredStatus = await runCommand('status restored v1', [
    binary,
    'status',
    '--project-dir',
    projectDir,
    '--state-dir',
    restoredStateDir,
  ], projectDir, isolatedEnvironment)
  assertMigrationStatus(restoredStatus, [v1], [v2], 'restored pre-upgrade snapshot')
  assert(
    await readFile(join(restoredStateDir, 'storage', 'upgrade-sentinel.txt'), 'utf8') === 'preserved-storage-v1',
    'pre-upgrade snapshot did not preserve local storage',
  )
  assert(
    await readFile(join(restoredStateDir, 'secrets.json'), 'utf8') === secretsBeforeUpgrade,
    'pre-upgrade snapshot did not preserve project secrets',
  )
  await withServer({
    phaseLabel: 'server restored v1',
    binary,
    projectDir,
    environment: isolatedEnvironment,
    stateDir: restoredStateDir,
  }, async (url) => {
    const response = await fetch(`${url}/rest/v1/upgrade_probe?select=id,body&id=eq.1`, {
      headers: { apikey: anonKey },
    })
    assert(response.status === 200, `restored v1 read returned HTTP ${response.status}`)
    const rows = await response.json() as Array<{ id: number; body: string }>
    assert(rows[0]?.body === 'preserved-v1', 'pre-upgrade snapshot did not preserve v1 data')
  })

  const statusV2 = await runCommand(
    'status v2',
    [binary, 'status', '--project-dir', projectDir],
    projectDir,
    isolatedEnvironment,
  )
  assertMigrationStatus(statusV2, [v1, v2], [], 'v2')
  assert(await readFile(storageSentinel, 'utf8') === 'preserved-storage-v1', 'upgrade changed local storage')

  await withServer({ phaseLabel: 'server v2', binary, projectDir, environment: isolatedEnvironment }, async (url) => {
    const response = await fetch(`${url}/rest/v1/upgrade_probe?select=id,body,upgraded&id=eq.1`, {
      headers: { apikey: anonKey },
    })
    const bodyText = await response.text()
    assert(response.status === 200, `post-upgrade read returned HTTP ${response.status}: ${bodyText}`)
    const rows = JSON.parse(bodyText) as Array<{ id: number; body: string; upgraded: boolean }>
    assert(rows.length === 1, `expected one preserved row, got ${rows.length}`)
    assert(rows[0]?.body === 'preserved-v1', 'v1 data was not preserved')
    assert(rows[0]?.upgraded === true, 'v2 field was not readable')
  })

  console.log('standalone-smoke-ok')
} finally {
  await Promise.all([
    rm(projectDir, { recursive: true, force: true }),
    rm(emptyPath, { recursive: true, force: true }),
  ])
}

function withoutRuntimePath(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: path }
  if (process.platform === 'win32') environment.Path = path
  return environment
}

function resolveStandaloneBinary(): string {
  const configuredBinary = process.env.SUPACLOUD_LITE_STANDALONE_BINARY
  if (configuredBinary) return resolve(configuredBinary)
  const filename = process.platform === 'win32' ? 'supacloud-lite.exe' : 'supacloud-lite'
  return join(packageDir, 'dist', 'standalone', filename)
}

interface ServerOptions {
  phaseLabel: string
  binary: string
  projectDir: string
  environment: NodeJS.ProcessEnv
  stateDir?: string
}

async function withServer(options: ServerOptions, check: (url: string) => Promise<void>): Promise<void> {
  const port = await findEphemeralPort()
  const stateArgs = options.stateDir ? ['--state-dir', options.stateDir] : []
  console.log(`[standalone-smoke] ${options.phaseLabel}: start`)
  const processHandle = Bun.spawn({
    cmd: [options.binary, 'start', '--project-dir', options.projectDir, '--host', '127.0.0.1', '--port', String(port), ...stateArgs],
    cwd: options.projectDir,
    env: options.environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(processHandle.stdout).text()
  const stderr = new Response(processHandle.stderr).text()
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(url, processHandle)
    console.log(`[standalone-smoke] ${options.phaseLabel}: healthy`)
    await check(url)
  } finally {
    console.log(`[standalone-smoke] ${options.phaseLabel}: stop`)
    processHandle.kill('SIGTERM')
    const exitCode = await withWindowsSubprocessRef(() => processHandle.exited)
    const expectedExitCode = expectedStandaloneShutdownExitCode()
    console.log(
      `[standalone-smoke] ${options.phaseLabel}: ${exitCode === expectedExitCode ? 'ok' : 'failed'} (exit ${exitCode})`,
    )
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
    if (exitCode !== expectedExitCode) {
      throw new Error(`standalone server exited with ${exitCode}\n${stdoutText}\n${stderrText}`)
    }
  }
}

function expectedStandaloneShutdownExitCode(): number {
  // Windows process kill terminates a child instead of delivering SIGTERM.
  return process.platform === 'win32' ? 143 : 0
}

async function waitForHealth(url: string, processHandle: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`standalone server exited before becoming healthy (${processHandle.exitCode})`)
    try {
      if ((await fetch(`${url}/health`)).ok) return
    } catch {
      // 进程初始化 PGlite 时端口尚未开放，继续轮询。
    }
    await Bun.sleep(100)
  }
  throw new Error('standalone server did not become healthy within 10 seconds')
}

async function findEphemeralPort(): Promise<number> {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
  const port = listener.port
  listener.stop(true)
  return port
}

async function runCommand(
  commandLabel: string,
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  console.log(`[standalone-smoke] ${commandLabel}: start`)
  const { exitCode, stdout, stderr, timedOut } = await executeBufferedCommand({
    command,
    cwd,
    env,
    timeoutMs: commandTimeoutMs,
  })
  console.log(`[standalone-smoke] ${commandLabel}: ${exitCode === 0 ? 'ok' : 'failed'} (exit ${exitCode})`)
  if (timedOut) throw new Error(`standalone command "${commandLabel}" timed out after ${commandTimeoutMs}ms\n${stdout}\n${stderr}`)
  if (exitCode !== 0) throw new Error(`standalone command "${commandLabel}" failed (${exitCode})\n${stdout}\n${stderr}`)
  return stdout
}

function assertMigrationStatus(output: string, present: string[], absent: string[], label: string): void {
  for (const version of present) {
    const occurrences = output.split(/\r?\n/).filter((line) => line.trimStart().startsWith(version)).length
    assert(occurrences === 1, `${label} status should list ${version} exactly once, got ${occurrences}`)
  }
  for (const version of absent) assert(!output.includes(version), `${label} status unexpectedly listed ${version}`)
}

function parseAnonKey(output: string): string {
  const match = output.match(/anon key:\s*\n([^\n]+)/)
  if (!match?.[1]) throw new Error(`unable to parse anon key from CLI output: ${output}`)
  return match[1].trim()
}

function lineAfter(output: string, marker: string): string {
  const start = output.indexOf(marker)
  if (start < 0) throw new Error(`missing output marker: ${marker}`)
  return output.slice(start + marker.length).split('\n', 1)[0]!.trim()
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
