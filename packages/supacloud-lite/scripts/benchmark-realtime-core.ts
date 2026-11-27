/**
 * Realtime core FFI throughput and Bun event-loop blocking benchmark.
 *
 * The core is called synchronously over `bun:ffi`; while a call is running the
 * Bun event loop cannot serve sockets, timers or PGlite. Every row reports:
 *
 * - the sync latency of the work itself (JSON encode -> FFI -> JSON decode)
 * - the worst drift a 1 ms `setInterval` observes while calls run back to
 *   back, yielding to the loop between calls so the timer can actually fire
 *
 * Fan-out rows are replayed twice through `RealtimeEngine` with identical
 * sockets and frames: once with the TypeScript engine and once with the Rust
 * core injected. Numbers are synthetic, in-process and machine dependent; they
 * are regression guards, not a production SLA.
 *
 *   bun run scripts/benchmark-realtime-core.ts [--json] [--quick]
 *     [--connections 200] [--iterations 200] [--assert-max-lag 250]
 */
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import type { CdcEvent, Database } from '../src/runtime/db/database.js'
import { openRealtimeCore } from '../src/runtime/realtime/core-asset.js'
import { realtimeCoreLibraryName, type CoreRequest } from '../src/runtime/realtime/core-ffi.js'
import {
  RealtimeEngine,
  type RealtimeProtocolCore,
  type RealtimeSocketLike,
} from '../src/runtime/realtime/engine.js'

const packageDir = resolve(import.meta.dir, '..')
const libraryName = realtimeCoreLibraryName()
const libraryPath =
  process.env.SUPACLOUD_LITE_REALTIME_CORE ||
  [
    join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'release', libraryName),
    join(packageDir, '..', '..', 'crates', 'realtime-core', 'target', 'debug', libraryName),
    join(packageDir, 'dist', 'native', libraryName),
  ].find((candidate) => existsSync(candidate))

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')
const quick = args.includes('--quick')
const connections = numberOption('--connections') ?? (quick ? 50 : 200)
const iterations = numberOption('--iterations') ?? (quick ? 50 : 200)
const assertMaxLag = numberOption('--assert-max-lag')

function numberOption(name: string): number | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = Number(args[index + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`)
  return value
}

interface Stats {
  samples: number
  connections: number
  p50_ms: number
  p95_ms: number
  p99_ms: number
  max_ms: number
  ops_per_s: number
  response_bytes: number
}

interface LagStats {
  elapsed_ms: number
  timer_samples: number
  max_lag_ms: number
  p95_lag_ms: number
  share_blocked_pct: number
}

interface Measurement {
  stats: Stats
  lag: LagStats
}

/** Timer samples later than 1 ms interval + this margin count as blocked. */
const STALL_MARGIN_MS = 2

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function summarise(
  durations: number[],
  responseBytes: number,
  lags: number[],
  elapsed: number,
  count: number
): Measurement {
  durations.sort((left, right) => left - right)
  lags.sort((left, right) => left - right)
  const blocked = lags.reduce((sum, lag) => sum + Math.max(0, lag - STALL_MARGIN_MS), 0)
  const busy = durations.reduce((sum, duration) => sum + duration, 0)
  return {
    stats: {
      samples: durations.length,
      connections: count,
      p50_ms: round(percentile(durations, 0.5)),
      p95_ms: round(percentile(durations, 0.95)),
      p99_ms: round(percentile(durations, 0.99)),
      max_ms: round(durations.at(-1) ?? 0),
      ops_per_s: round(durations.length / Math.max(busy / 1000, 0.001)),
      response_bytes: responseBytes,
    },
    lag: {
      elapsed_ms: round(elapsed),
      timer_samples: lags.length,
      max_lag_ms: round(lags.at(-1) ?? 0),
      p95_lag_ms: round(percentile(lags, 0.95)),
      share_blocked_pct: round((blocked / Math.max(elapsed, 1)) * 100),
    },
  }
}

const settleFrame = () => new Promise<void>((done) => setImmediate(done))

/** Drop the previous row's garbage so heavy rows do not tax the next one. */
async function settleHeap(): Promise<void> {
  Bun.gc(true)
  await settleFrame()
  Bun.gc(true)
}

/**
 * Run `step` back to back while a 1 ms timer records how long it was starved.
 *
 * The loop must yield between steps: a synchronous FFI call blocks timers for
 * its whole duration, so without the yield the timer would only run after the
 * benchmark finished and never observe the stall.
 */
async function measure(step: () => unknown, count: number, responseBytes: number): Promise<Measurement> {
  const durations: number[] = []
  const lags: number[] = []
  let expected = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    lags.push(now - expected)
    expected = now + 1
  }, 1)
  const started = performance.now()
  try {
    for (let index = 0; index < iterations; index += 1) {
      const before = performance.now()
      await step()
      durations.push(performance.now() - before)
      await settleFrame()
    }
  } finally {
    clearInterval(timer)
  }
  return summarise(durations, responseBytes, lags, performance.now() - started, count)
}

function payload(bytes: number): Record<string, unknown> {
  return { blob: 'x'.repeat(Math.max(0, bytes - 12)) }
}

if (!libraryPath) {
  console.error(
    'realtime core library not found; run "bun run build:realtime-core" or set SUPACLOUD_LITE_REALTIME_CORE'
  )
  process.exit(1)
}

const opened = await openRealtimeCore({ path: libraryPath, ignoreEmbedded: true, env: {} })
const core = opened.core
const topic = 'realtime:bench'

/** Size of one core response, sampled once so the timed loop stays honest. */
function coreResponseBytes(request: CoreRequest): number {
  return JSON.stringify(core.call(request)).length
}

function joinCore(id: string, config: Record<string, unknown>): void {
  core.call({
    op: 'frame',
    connection_id: id,
    frame: ['1', '1', topic, 'phx_join', { config }],
  })
}

let joinedConnectionIds: string[] = []

/** Replace the joined population so each row fans out to exactly `count` sockets. */
function resetCoreConnections(config: Record<string, unknown>, count: number): void {
  for (const id of joinedConnectionIds) core.call({ op: 'disconnect', connection_id: id })
  joinedConnectionIds = Array.from({ length: count }, (_, index) => `bench-${index}`)
  for (const id of joinedConnectionIds) joinCore(id, config)
}

interface FanOutRow {
  label: string
  bytes: number
  count: number
}

try {
  // ── Core-only: what one synchronous `core.call` costs ──────────────────
  core.call({ op: 'disconnect', connection_id: 'bench-heartbeat' })
  const heartbeatRequest: CoreRequest = {
    op: 'frame',
    connection_id: 'bench-heartbeat',
    frame: ['1', '1', 'phoenix', 'heartbeat', {}],
  }
  const heartbeat = await measure(
    () => core.call(heartbeatRequest),
    1,
    coreResponseBytes(heartbeatRequest)
  )

  const bindings = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    event: 'INSERT',
    schema: 'public',
    table: `table_${index}`,
  }))
  const joinRequest: CoreRequest = {
    op: 'frame',
    connection_id: 'bench-join',
    frame: ['1', '1', topic, 'phx_join', { config: { postgres_changes: bindings } }],
  }
  core.call({ op: 'disconnect', connection_id: 'bench-join' })
  const joinBytes = coreResponseBytes(joinRequest)
  const joinMany = await measure(() => {
    core.call({ op: 'disconnect', connection_id: 'bench-join' })
    core.call(joinRequest)
  }, 1, joinBytes)

  const fanOutRows: FanOutRow[] = [
    { label: 'broadcast_1k', bytes: 1 * 1024, count: connections },
    { label: 'broadcast_64k', bytes: 64 * 1024, count: connections },
    // A 1 MiB payload fanned out to every connection would serialize hundreds
    // of MiB per call; keep the heavy row comparable but bounded.
    { label: 'broadcast_1m', bytes: 1024 * 1024, count: Math.min(connections, 20) },
  ]
  const coreFanOut: Record<string, Measurement> = {}
  for (const row of fanOutRows) {
    await settleHeap()
    resetCoreConnections({ broadcast: { self: false } }, row.count)
    const request: CoreRequest = {
      op: 'frame',
      connection_id: 'bench-0',
      frame: ['1', '2', topic, 'broadcast', { type: 'broadcast', event: 'm', payload: payload(row.bytes) }],
    }
    coreFanOut[row.label] = await measure(() => core.call(request), row.count, coreResponseBytes(request))
  }

  const cdcCount = Math.min(connections, 20)
  resetCoreConnections(
    { postgres_changes: [{ id: 1, event: 'INSERT', schema: 'public', table: 'bench' }] },
    cdcCount
  )
  const cdcEvent: CdcEvent = {
    schema: 'public',
    table: 'bench',
    type: 'INSERT',
    commit_timestamp: '2026-01-01T00:00:00.000Z',
    record: payload(1024 * 1024),
    old_record: null,
  }
  // Same shape the engine sends for a CDC event (see `dispatchCoreCdc`).
  const cdcRequest: CoreRequest = {
    op: 'cdc',
    event: {
      schema: cdcEvent.schema,
      table: cdcEvent.table,
      type: cdcEvent.type,
      record: cdcEvent.record,
      old_record: cdcEvent.old_record ?? {},
      columns: [],
      commit_timestamp: cdcEvent.commit_timestamp,
      errors: null,
    },
  }
  await settleHeap()
  const coreCdc = await measure(() => core.call(cdcRequest), cdcCount, coreResponseBytes(cdcRequest))

  // ── Engine end-to-end: same sockets and frames, TS engine vs Rust core ─
  class CountingSocket implements RealtimeSocketLike {
    bytes = 0
    send(data: string | Uint8Array): void {
      this.bytes += typeof data === 'string' ? data.length : data.byteLength
    }
    close(): void {}
  }
  const fakeDb = {
    engine: { minimalBootstrap: true },
    ensureCdcTrigger: async () => {},
    getSchemaInfo: async () => ({
      tables: new Map([['bench', { columns: [{ name: 'id', udtName: 'int4' }], primaryKey: ['id'] }]]),
    }),
    getRlsTables: async () => new Set<string>(),
    withContext: async () => ({ rows: [] }),
  } as unknown as Database

  interface EngineRow extends FanOutRow {
    cdc?: boolean
  }

  async function measureEngine(row: EngineRow, protocolCore: RealtimeProtocolCore | undefined): Promise<Measurement> {
    const engine = new RealtimeEngine(fakeDb, undefined, undefined, protocolCore ? { core: protocolCore } : {})
    try {
      const sockets = Array.from({ length: row.count }, () => new CountingSocket())
      const handlers = sockets.map((socket) => engine.connect(socket))
      const config = row.cdc
        ? { postgres_changes: [{ id: 1, event: 'INSERT', schema: 'public', table: 'bench' }] }
        : { broadcast: { self: false } }
      for (const handler of handlers) {
        handler.onMessage(JSON.stringify({ topic, event: 'phx_join', ref: '1', payload: { config } }))
      }
      await settleFrame()

      const body = payload(row.bytes)
      const frame = JSON.stringify({
        topic,
        event: 'broadcast',
        ref: '2',
        payload: { type: 'broadcast', event: 'm', payload: body },
      })
      const event: CdcEvent = {
        schema: 'public',
        table: 'bench',
        type: 'INSERT',
        commit_timestamp: '2026-01-01T00:00:00.000Z',
        record: body,
        old_record: null,
      }
      const dispatchCdc = (engine as unknown as { dispatchCdc(event: CdcEvent): Promise<void> }).dispatchCdc.bind(
        engine
      )
      const step = async (): Promise<void> => {
        if (row.cdc) {
          await dispatchCdc(event)
        } else {
          handlers[0]!.onMessage(frame)
          await settleFrame()
        }
      }

      // One warm-up pass doubles as the response size probe.
      const before = sockets.reduce((sum, socket) => sum + socket.bytes, 0)
      await step()
      await settleFrame()
      const responseBytes = sockets.reduce((sum, socket) => sum + socket.bytes, 0) - before
      return await measure(step, row.count, responseBytes)
    } finally {
      await engine.stop()
    }
  }

  const engineRows: EngineRow[] = [...fanOutRows, { label: 'cdc_1m_record_to_20', bytes: 1024 * 1024, count: cdcCount, cdc: true }]
  const engineTypescript: Record<string, Measurement> = {}
  const engineRustCore: Record<string, Measurement> = {}
  for (const row of engineRows) {
    await settleHeap()
    engineTypescript[row.label] = await measureEngine(row, undefined)
    await settleHeap()
    engineRustCore[row.label] = await measureEngine(row, core)
  }

  const report = {
    schema: 'supacloud.lite-realtime-core-benchmark.v2',
    scope: 'synthetic-in-process-not-production-sla',
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    core: { path: opened.path, abi_version: core.abiVersion },
    parameters: { connections, iterations, quick },
    core_ffi: {
      heartbeat,
      join_50_bindings: joinMany,
      ...coreFanOut,
      cdc_1m_record_to_20: coreCdc,
    },
    engine_typescript: engineTypescript,
    engine_rust_core: engineRustCore,
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const line = (name: string, entry: Measurement) =>
      `${name.padEnd(28)} p50 ${String(entry.stats.p50_ms).padStart(8)} ms  p99 ${String(entry.stats.p99_ms).padStart(8)} ms  max ${String(entry.stats.max_ms).padStart(8)} ms  max lag ${String(entry.lag.max_lag_ms).padStart(8)} ms  blocked ${String(entry.lag.share_blocked_pct).padStart(5)} %`
    console.log(`Realtime core FFI benchmark (${connections} connections, ${iterations} iterations)`)
    console.log(line('core heartbeat', heartbeat))
    console.log(line('core join 50 bindings', joinMany))
    for (const row of fanOutRows) console.log(line(`core ${row.label}`, coreFanOut[row.label]!))
    console.log(line('core cdc 1 MiB x20', coreCdc))
    for (const [label, entry] of Object.entries(engineTypescript)) console.log(line(`ts engine ${label}`, entry))
    for (const [label, entry] of Object.entries(engineRustCore)) console.log(line(`rust engine ${label}`, entry))
  }

  if (assertMaxLag !== undefined) {
    const rows: [string, Measurement][] = [
      ['core heartbeat', heartbeat],
      ['core join 50 bindings', joinMany],
      ...Object.entries(coreFanOut).map(([label, entry]) => [`core ${label}`, entry] as [string, Measurement]),
      ['core cdc 1 MiB x20', coreCdc],
      ...Object.entries(engineRustCore).map(([label, entry]) => [`rust engine ${label}`, entry] as [string, Measurement]),
    ]
    const [worstLabel, worst] = rows.reduce((left, right) => (right[1].lag.max_lag_ms > left[1].lag.max_lag_ms ? right : left))
    if (worst.lag.max_lag_ms > assertMaxLag) {
      console.error(`${worstLabel}: event loop lag ${worst.lag.max_lag_ms} ms exceeded the ${assertMaxLag} ms budget`)
      process.exit(1)
    }
    // Keep stdout pure JSON when a report is requested.
    ;(jsonOutput ? console.error : console.log)(
      `worst event loop lag ${worst.lag.max_lag_ms} ms (${worstLabel}) within the ${assertMaxLag} ms budget`
    )
  }
} finally {
  await opened.close()
}
