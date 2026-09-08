const limits = [1, 5, 30, 60, 300, 900, 3600];
const buckets = limits.map(() => 0);
let count = 0;
let failures = 0;
let sum = 0;

export function recordBackgroundObservation(waitSeconds: number, failed: boolean): void {
  const wait = Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) : 0;
  count++;
  if (failed) failures++;
  sum += wait;
  limits.forEach((limit, index) => { if (wait <= limit) buckets[index]!++; });
}

export function renderBackgroundMetrics(): string {
  const name = "supacloud_background_queue_wait_seconds";
  return [
    "# TYPE supacloud_background_attempts_total counter",
    `supacloud_background_attempts_total ${count}`,
    "# TYPE supacloud_background_failures_total counter",
    `supacloud_background_failures_total ${failures}`,
    `# HELP ${name} Time from task creation to the start of a dispatched attempt.`,
    `# TYPE ${name} histogram`,
    ...limits.map((limit, index) => `${name}_bucket{le="${limit}"} ${buckets[index]}`),
    `${name}_bucket{le="+Inf"} ${count}`, `${name}_sum ${sum}`, `${name}_count ${count}`,
  ].join("\n") + "\n";
}

export function resetBackgroundMetricsForTests(): void {
  count = 0; failures = 0; sum = 0; buckets.fill(0);
}
