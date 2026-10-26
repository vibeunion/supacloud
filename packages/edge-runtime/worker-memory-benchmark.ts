import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";
import { BODY_CHUNK_BYTES, bodyBufferBudget, responseBufferBudget } from "./body-transfer";

// Compare in separate processes. --pool-module accepts a baseline checkout's worker-pool.ts.
const option = (name: string, fallback: string) => {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? fallback : Bun.argv[index + 1] ?? fallback;
};
const numeric = (name: string, fallback: number) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const concurrency = numeric("--concurrency", 30);
const batches = numeric("--batches", 1);
if (concurrency === 0 || batches === 0) throw new Error("Concurrency and batches must be positive");
const workers = numeric("--workers", 4);
const responseMiB = numeric("--response-mib", 8);
const pauseMs = numeric("--pause-ms", 250);
const consumerDelay = numeric("--delay-per-64k-ms", 1);
const mode = option("--mode", "ordinary");
const baselineModule = option("--pool-module", "");
const Pool = baselineModule ? (await import(baselineModule)).WorkerPool as typeof WorkerPool : WorkerPool;
const root = await mkdtemp(join(tmpdir(), "edge-memory-benchmark-"));
const file = join(root, "fn.ts");
await Bun.write(file, `
  export default (request) => {
    const url = new URL(request.url);
    let remaining = Number(url.searchParams.get('mib'));
    if (!remaining) return new Response('ok');
    return new Response(new ReadableStream({
      pull(controller) {
        if (!remaining--) { controller.close(); return; }
        controller.enqueue(new Uint8Array(1024 * 1024).fill(37));
      }
    }, { highWaterMark: 0 }), { headers: {
      'content-type': url.searchParams.get('mode') === 'sse' ? 'text/event-stream' : 'application/octet-stream'
    } });
  };
`);
const pool = new Pool({ size: workers, requestTimeout: 60_000, smol: true });
const dispatch = (mib: number) => pool.dispatch({
  functionId: "benchmark", projectRef: "benchmark", projectRoot: root, functionPath: file, env: {},
  request: new Request(`http://edge.test/fn?mib=${mib}&mode=${mode}`, {
    headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` },
  }),
});
let peak = 0;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  await Promise.all(Array.from({ length: concurrency }, async () => (await dispatch(0)).text()));
  Bun.gc(true); // Benchmark normalization only, never in the serving path.
  const baselineRss = process.memoryUsage().rss;
  peak = baselineRss;
  timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const started = performance.now();
  const latencies: number[] = [];
  const headersMs: number[] = [];
  const cpuStart = process.cpuUsage();
  let consumed = 0;
  for (let batch = 0; batch < batches; batch++) {
    const batchStarted = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      const response = await dispatch(responseMiB);
      headersMs.push(performance.now() - batchStarted);
      if (response.status !== 200) throw new Error(`Unexpected status ${response.status}`);
      if (pauseMs) await Bun.sleep(pauseMs);
      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        consumed += value.byteLength;
        // Same byte-based consumer rate for aggregate and streamed responses.
        if (consumerDelay) await Bun.sleep(consumerDelay * value.byteLength / (64 * 1024));
      }
      latencies.push(performance.now() - batchStarted);
    }));
  }
  const elapsedMs = Math.round(performance.now() - started);
  const cpu = process.cpuUsage(cpuStart);
  await pool.drain();
  peak = Math.max(peak, process.memoryUsage().rss);
  latencies.sort((a, b) => a - b);
  headersMs.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, concurrency, batches, workers, responseMiB, pauseMs, consumerDelay,
    bun: Bun.version, platform: process.platform, readAheadBytes: process.env.EDGE_RESPONSE_READ_AHEAD_BYTES ?? "default",
    responseBufferBudgetBytes: baselineModule ? null : responseBufferBudget.limit,
    transferChunkBytes: baselineModule ? null : BODY_CHUNK_BYTES,
    requestsPerSecond: Math.round(concurrency * batches * 1000 / Math.max(1, elapsedMs)),
    processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    p95HeadersMs: Math.round(headersMs[Math.floor(headersMs.length * 0.95)] ?? 0),
    baselineRssMiB: Math.round(baselineRss / 1048576), peakRssMiB: Math.round(peak / 1048576),
    consumedMiB: consumed / 1048576, elapsedMs,
    p95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0),
    bufferBudgetPeakBytes: baselineModule ? null : bodyBufferBudget.peak,
    bufferBudgetRemainingBytes: baselineModule ? null : bodyBufferBudget.used,
    responseBufferPeakBytes: baselineModule ? null : responseBufferBudget.peak,
    responseBufferRemainingBytes: baselineModule ? null : responseBufferBudget.used,
    workerReplacements: pool.snapshotMetrics().supacloud_edge_total_worker_replacements,
    workerHeapBytes: pool.snapshotMetrics().supacloud_edge_worker_heap_bytes,
    workerHeapCapacityBytes: pool.snapshotMetrics().supacloud_edge_worker_heap_capacity_bytes,
    workerExtraMemoryBytes: pool.snapshotMetrics().supacloud_edge_worker_extra_memory_bytes,
  }));
} finally {
  clearInterval(timer);
  await pool.shutdown();
  await rm(root, { recursive: true, force: true });
}
