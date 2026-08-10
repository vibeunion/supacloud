import { expect, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import {
  STANDALONE_PGLITE_ASSETS,
  type StandalonePgliteAssets,
} from '../src/standalone-assets-protocol.js'
import { createPgliteEngine } from '../src/runtime/db/pglite-engine.js'

interface EngineTimezoneProbe {
  kind: 'engine'
  session_timezone: string
  observed_at: string
}

interface DataApiTimezoneProbe {
  kind: 'data-api'
  session_timezone: string
  table_observed_at: string
  rpc_observed_at: string
}

type TimezoneProbe = EngineTimezoneProbe | DataApiTimezoneProbe

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

test('defaults fresh and reopened databases to UTC while preserving an explicit database timezone', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-timezone-'))
  try {
    const freshFull = await runTimezoneProbe(join(projectDir, 'fresh-full'), 'full', 'Asia/Shanghai')
    expectFullUtcProbe(freshFull)

    const reopenedFullDir = join(projectDir, 'reopened-full')
    expectLegacyHostTimezone(await runTimezoneProbe(reopenedFullDir, 'create-legacy', 'Asia/Shanghai'))
    expectFullUtcProbe(await runTimezoneProbe(reopenedFullDir, 'full', 'UTC'))

    const freshMinimal = await runTimezoneProbe(join(projectDir, 'fresh-minimal'), 'minimal', 'Asia/Shanghai')
    expectMinimalUtcProbe(freshMinimal)

    const reopenedMinimalDir = join(projectDir, 'reopened-minimal')
    expectLegacyHostTimezone(await runTimezoneProbe(reopenedMinimalDir, 'create-legacy', 'Asia/Shanghai'))
    expectMinimalUtcProbe(await runTimezoneProbe(reopenedMinimalDir, 'minimal', 'UTC'))

    const customTimezoneDir = join(projectDir, 'custom-timezone')
    await runTimezoneProbe(customTimezoneDir, 'set-custom-timezone', 'UTC')
    expectCustomTimezone(await runTimezoneProbe(customTimezoneDir, 'full', 'UTC'))
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)

test('closes a ready PGlite instance when timezone initialization fails', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-timezone-failure-'))
  const dataDir = join(projectDir, 'db')
  const lockPath = `${dataDir}.supacloud-lite.lock`
  const initializationError = new Error('forced timezone initialization failure')
  const originalExec = PGlite.prototype.exec
  let failedInstance: PGlite | undefined
  PGlite.prototype.exec = async function (query, options) {
    if (query.includes('declare configured_timezone')) {
      failedInstance = this
      throw initializationError
    }
    return originalExec.call(this, query, options)
  }
  try {
    await expect(createPgliteEngine(dataDir)).rejects.toBe(initializationError)
    expect(failedInstance?.closed).toBe(true)
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    PGlite.prototype.exec = originalExec
    if (failedInstance && !failedInstance.closed) await failedInstance.close()
    await rm(projectDir, { recursive: true, force: true })
  }
}, 30_000)

async function runTimezoneProbe(
  dataDir: string,
  probeMode:
    | 'create-legacy'
    | 'full'
    | 'minimal'
    | 'set-custom-timezone',
  timezone: string
): Promise<TimezoneProbe> {
  const child = Bun.spawn([process.execPath, 'test/helpers/timezone-probe.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      TZ: timezone,
      SUPACLOUD_LITE_TIMEZONE_DATA_DIR: dataDir,
      SUPACLOUD_LITE_TIMEZONE_PROBE_MODE: probeMode,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, stderr).toBe(0)
  return parseTimezoneProbe(stdout)
}

function expectLegacyHostTimezone(probe: TimezoneProbe): void {
  expect(probe.kind).toBe('engine')
  if (probe.kind !== 'engine') throw new Error('legacy timezone probe did not use the engine path')
  expect(probe.session_timezone).not.toBe('UTC')
  expect(probe.observed_at).toBe('2026-08-10T08:00:00+08:00')
}

function expectFullUtcProbe(probe: TimezoneProbe): void {
  expect(probe.kind).toBe('data-api')
  if (probe.kind !== 'data-api') throw new Error('full timezone probe did not use the Data API path')
  expect(probe.session_timezone).toBe('UTC')
  expect(probe.table_observed_at).toBe('2026-08-10T00:00:00+00:00')
  expect(probe.rpc_observed_at).toBe('2026-08-10T00:00:00+00:00')
}

function expectMinimalUtcProbe(probe: TimezoneProbe): void {
  expect(probe.kind).toBe('engine')
  if (probe.kind !== 'engine') throw new Error('minimal timezone probe did not use the engine path')
  expect(probe.session_timezone).toBe('UTC')
  expect(probe.observed_at).toBe('2026-08-10T00:00:00+00:00')
}

function expectCustomTimezone(probe: TimezoneProbe): void {
  expect(probe.kind).toBe('data-api')
  if (probe.kind !== 'data-api') throw new Error('custom timezone probe did not use the Data API path')
  expect(probe.session_timezone).toBe('Asia/Shanghai')
  expect(probe.table_observed_at).toBe('2026-08-10T08:00:00+08:00')
  expect(probe.rpc_observed_at).toBe('2026-08-10T08:00:00+08:00')
}

function parseTimezoneProbe(serializedProbe: string): TimezoneProbe {
  const parsedProbe: unknown = JSON.parse(serializedProbe)
  if (typeof parsedProbe !== 'object' || parsedProbe === null) throw new Error('timezone probe returned no object')
  const probeRecord = parsedProbe as Record<string, unknown>
  if (typeof probeRecord.session_timezone !== 'string') throw new Error('timezone probe omitted session timezone')
  if (probeRecord.kind === 'engine' && typeof probeRecord.observed_at === 'string') {
    return {
      kind: 'engine',
      session_timezone: probeRecord.session_timezone,
      observed_at: probeRecord.observed_at,
    }
  }
  if (
    probeRecord.kind === 'data-api'
    && typeof probeRecord.table_observed_at === 'string'
    && typeof probeRecord.rpc_observed_at === 'string'
  ) {
    return {
      kind: 'data-api',
      session_timezone: probeRecord.session_timezone,
      table_observed_at: probeRecord.table_observed_at,
      rpc_observed_at: probeRecord.rpc_observed_at,
    }
  }
  throw new Error('timezone probe returned an invalid shape')
}
