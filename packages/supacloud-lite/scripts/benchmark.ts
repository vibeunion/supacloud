import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'
import { createNativeEngine } from '../src/runtime/node/native/engine.js'

const engineName = process.argv.includes('--native') ? 'native' : 'pglite'
const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-benchmark-'))
let backend: Awaited<ReturnType<typeof createBackend>> | undefined
const samples = 30
const measurement = async (operation: () => Promise<void>) => {
  for (let index = 0; index < 5; index++) await operation()
  const times: number[] = []
  for (let index = 0; index < samples; index++) {
    const start = performance.now()
    await operation()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return { samples, p50_ms: times[Math.ceil(samples * 0.5) - 1], p95_ms: times[Math.ceil(samples * 0.95) - 1], max_ms: times.at(-1) }
}
try {
  const before = process.memoryUsage().rss
  const start = performance.now()
  const engine = engineName === 'native' ? await createNativeEngine({ dataDir: join(root, 'pg') }) : undefined
  backend = await createBackend({
    engine, startRuntimeServices: false, log: () => {},
    functions: { ping: () => Response.json({ ok: true }) },
    migrations: [{ name: '100_benchmark', sql: `
      create table public.benchmark_items(id int primary key, label text not null);
      insert into public.benchmark_items select i, 'item-' || i from generate_series(1, 1000) as i;
      grant select on public.benchmark_items to anon;
      create function public.benchmark_count() returns integer language sql stable as $$ select count(*)::int from public.benchmark_items $$;
      grant execute on function public.benchmark_count() to anon;
    ` }],
  })
  const startup = performance.now() - start
  const rss = process.memoryUsage().rss
  const request = async (path: string, method = 'GET') => {
    const response = await backend!.fetch(`http://local${path}`, { method, headers: { apikey: backend!.anonKey } })
    if (!response.ok) throw new Error(`benchmark request failed with ${response.status}`)
    await response.arrayBuffer()
  }
  const report = {
    schema: 'supacloud.lite-benchmark.v1', scope: 'synthetic-in-process-not-production-sla',
    engine: engineName, bun: Bun.version, platform: process.platform, arch: process.arch,
    rows: 1000, warmup_requests: 5, startup_ms: startup,
    process_rss_bytes: rss, process_rss_delta_bytes: rss - before,
    memory_scope: 'Bun process only; native PostgreSQL child memory excluded',
    rest: await measurement(() => request('/rest/v1/benchmark_items?select=id,label&limit=20')),
    rpc: await measurement(() => request('/rest/v1/rpc/benchmark_count', 'POST')),
    function: await measurement(() => request('/functions/v1/ping')),
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { await backend?.close() }
  finally { await rm(root, { recursive: true, force: true }) }
}
