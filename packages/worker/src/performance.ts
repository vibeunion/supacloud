interface Window {
  startedAtMs: number;
  seconds: number;
  latenciesMs: number[];
  errors: number;
}
interface Limits {
  minWindowSeconds: number;
  minRequests: number;
  minRps: number;
  maxP95Ms: number;
  maxP99Ms: number;
  maxP99Ratio: number;
  maxErrorRate: number;
  maxBatchSeconds: number;
  maxOldestQueueAgeSeconds: number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  return value;
}
function count(value: unknown, min = 0): number {
  const result = number(value, min);
  if (!Number.isSafeInteger(result)) throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  return result;
}
function window(value: unknown): Window {
  const input = object(value);
  if (!Array.isArray(input.latenciesMs) || input.latenciesMs.length === 0)
    throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  return {
    startedAtMs: count(input.startedAtMs),
    seconds: number(input.seconds, Number.EPSILON),
    latenciesMs: input.latenciesMs.map(value => number(value, Number.EPSILON)),
    errors: count(input.errors),
  };
}
function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}
function metrics(value: Window) {
  const sorted = [...value.latenciesMs].sort((a, b) => a - b);
  const requests = sorted.length;
  if (value.errors > requests) throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  return {
    requests,
    startedAtMs: value.startedAtMs,
    seconds: value.seconds,
    rps: requests / value.seconds,
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    errorRate: value.errors / requests,
  };
}

/** Evaluates supplied measurements; does not generate load or attest their provenance. */
export function evaluateWorkerPerformance(value: unknown) {
  const input = object(value);
  const source = object(input.limits);
  const limits: Limits = {
    minWindowSeconds: number(source.minWindowSeconds, 1),
    minRequests: count(source.minRequests, 1),
    minRps: number(source.minRps, Number.EPSILON),
    maxP95Ms: number(source.maxP95Ms, Number.EPSILON),
    maxP99Ms: number(source.maxP99Ms, Number.EPSILON),
    maxP99Ratio: number(source.maxP99Ratio, 1),
    maxErrorRate: number(source.maxErrorRate, 0, 1),
    maxBatchSeconds: number(source.maxBatchSeconds, Number.EPSILON),
    maxOldestQueueAgeSeconds: number(source.maxOldestQueueAgeSeconds, 0),
  };
  if (limits.maxP95Ms > limits.maxP99Ms)
    throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  const baseline = metrics(window(input.baseline));
  const mixed = metrics(window(input.mixed));
  const batchInput = object(input.batch);
  const batch = {
    startedAtMs: count(batchInput.startedAtMs),
    expected: count(batchInput.expected, 1),
    completed: count(batchInput.completed),
    seconds: number(batchInput.seconds, Number.EPSILON),
    peakOldestQueueAgeSeconds: number(batchInput.peakOldestQueueAgeSeconds, 0),
  };
  // Labels identify the intended experiment; the evaluator cannot attest provenance.
  const evidence = object(input.evidence);
  for (const key of ["candidate", "hardware", "workload", "rawArtifact"] as const) {
    if (typeof evidence[key] !== "string" || !evidence[key].trim())
      throw new Error("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  }
  const failures: string[] = [];
  const baselineEnd = baseline.startedAtMs + baseline.seconds * 1000;
  const mixedEnd = mixed.startedAtMs + mixed.seconds * 1000;
  const batchEnd = batch.startedAtMs + batch.seconds * 1000;
  if (baselineEnd > batch.startedAtMs || baselineEnd > mixed.startedAtMs)
    failures.push("BASELINE_OVERLAPS_LOAD");
  if (mixed.startedAtMs < batch.startedAtMs || mixedEnd > batchEnd)
    failures.push("MIXED_WINDOW_OUTSIDE_BATCH");
  for (const [name, result] of [["BASELINE", baseline], ["MIXED", mixed]] as const) {
    if (result.seconds < limits.minWindowSeconds || result.requests < limits.minRequests)
      failures.push(`${name}_INSUFFICIENT_SAMPLES`);
    if (result.rps < limits.minRps) failures.push(`${name}_THROUGHPUT`);
    if (result.p95Ms > limits.maxP95Ms) failures.push(`${name}_P95`);
    if (result.p99Ms > limits.maxP99Ms) failures.push(`${name}_P99`);
    if (result.errorRate > limits.maxErrorRate) failures.push(`${name}_ERROR_RATE`);
  }
  if (mixed.p99Ms / baseline.p99Ms > limits.maxP99Ratio) failures.push("MIXED_P99_REGRESSION");
  if (batch.completed !== batch.expected) failures.push("BATCH_INCOMPLETE");
  if (batch.seconds > limits.maxBatchSeconds) failures.push("BATCH_DEADLINE");
  if (batch.peakOldestQueueAgeSeconds > limits.maxOldestQueueAgeSeconds) failures.push("QUEUE_AGE");
  return { passed: failures.length === 0, failures, baseline, mixed, batch };
}
