export interface WorkerLoadSpec {
  durationMs: number;
  requestsPerSecond: number;
  maxInFlight: number;
  requestTimeoutMs: number;
  p95Ms: number;
  p99Ms: number;
  maxErrorRate: number;
  maxLatencyRegression: number;
  drainTimeoutMs: number;
}
export interface WorkerLoadMeasurement {
  offered: number;
  completed: number;
  errors: number;
  dropped: number;
  p95Ms: number | null;
  p99Ms: number | null;
  maxSchedulingLagMs: number;
  errorRate: number;
}
export interface WorkerAcceptancePorts {
  /** Consume the response body and honor the signal; returning true means a valid business response. */
  request(signal: AbortSignal): Promise<boolean>;
  /** Returns an authoritative batch identity. Never use a queue message ID as business completion. */
  startBatch(): Promise<string>;
  batchComplete(operationId: string, signal: AbortSignal): Promise<boolean>;
}

function validate(spec: WorkerLoadSpec) {
  const positive = [spec.durationMs, spec.requestsPerSecond, spec.maxInFlight, spec.requestTimeoutMs,
    spec.p95Ms, spec.p99Ms, spec.drainTimeoutMs];
  if (positive.some(value => !Number.isFinite(value) || value <= 0)
    || !Number.isSafeInteger(spec.maxInFlight) || spec.maxInFlight > 10000 || spec.durationMs > 3600000
    || spec.requestsPerSecond > 100000 || Math.ceil(spec.durationMs * spec.requestsPerSecond / 1000) > 1_000_000
    || !Number.isFinite(spec.maxErrorRate) || spec.maxErrorRate < 0 || spec.maxErrorRate > 1
    || !Number.isFinite(spec.maxLatencyRegression) || spec.maxLatencyRegression < 0 || spec.p99Ms < spec.p95Ms) {
    throw new Error("WORKER_LOAD_SPEC_INVALID");
  }
}

/** Fixed offered rate. Saturation is counted, never hidden by a slower closed-loop client. */
export async function measureWorkerApiLoad(
  spec: WorkerLoadSpec, request: WorkerAcceptancePorts["request"],
): Promise<WorkerLoadMeasurement> {
  validate(spec);
  const offered = Math.ceil(spec.durationMs * spec.requestsPerSecond / 1000);
  const latencies: number[] = [];
  const pending = new Set<Promise<void>>();
  let errors = 0, dropped = 0, maxSchedulingLagMs = 0;
  const start = performance.now();
  for (let i = 0; i < offered; i++) {
    const due = start + i * 1000 / spec.requestsPerSecond;
    if (performance.now() < due) await new Promise(resolve => setTimeout(resolve, due - performance.now()));
    maxSchedulingLagMs = Math.max(maxSchedulingLagMs, performance.now() - due);
    if (pending.size >= spec.maxInFlight) { dropped++; continue; }
    const began = performance.now();
    const work: Promise<void> = Promise.resolve().then(async () => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), spec.requestTimeoutMs);
      try {
        // Adapters must enforce transport cancellation; no request result is fabricated on timeout.
        const ok = await request(abort.signal);
        if (!ok || abort.signal.aborted) errors++;
      } catch { errors++; }
      finally {
        clearTimeout(timeout); latencies.push(performance.now() - began);
      }
    }).finally(() => { pending.delete(work); });
    pending.add(work);
  }
  await Promise.all(pending);
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
  return { offered, completed: latencies.length, errors, dropped,
    p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxSchedulingLagMs,
    errorRate: (errors + dropped) / offered };
}

/** Execute only against a separately authorized test target with an approved load specification. */
export async function acceptWorkerMixedLoad(spec: WorkerLoadSpec, ports: WorkerAcceptancePorts) {
  validate(spec);
  const baseline = await measureWorkerApiLoad(spec, ports.request);
  const batchOperationId = await ports.startBatch();
  if (!batchOperationId || batchOperationId.length > 200) throw new Error("WORKER_BATCH_ID_INVALID");
  const mixed = await measureWorkerApiLoad(spec, ports.request);
  const signal = AbortSignal.timeout(spec.drainTimeoutMs);
  const began = performance.now();
  let batchComplete = false;
  try {
    while (!signal.aborted) {
      if (await ports.batchComplete(batchOperationId, signal)) { batchComplete = true; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, spec.drainTimeoutMs)));
    }
  } catch { /* Failure to observe completion is not a failed/rolled-back business operation. */ }
  const within = (sample: WorkerLoadMeasurement) => sample.p95Ms !== null && sample.p99Ms !== null
    && sample.p95Ms <= spec.p95Ms && sample.p99Ms <= spec.p99Ms
    && sample.errorRate <= spec.maxErrorRate && sample.dropped === 0
    && sample.maxSchedulingLagMs <= Math.max(10, 1000 / spec.requestsPerSecond);
  const regression = baseline.p99Ms !== null && mixed.p99Ms !== null
    && mixed.p99Ms <= Math.max(1, baseline.p99Ms) * (1 + spec.maxLatencyRegression);
  return {
    schema: "supacloud.worker-load-acceptance.v1", observedAt: new Date().toISOString(),
    spec, baseline, mixed, batchOperationId, batchComplete,
    drainObservedMs: performance.now() - began,
    passed: within(baseline) && within(mixed) && regression && batchComplete,
  };
}
