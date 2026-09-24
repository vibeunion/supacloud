/**
 * In-process metrics for the pgredis data plane, rendered as Prometheus
 * exposition text. The service is a single process per node, so module-level
 * counters are sufficient; they are intentionally cheap and lock-free.
 */

export type CacheOperation =
  | "get"
  | "set"
  | "delete"
  | "ttl"
  | "getset"
  | "getdel"
  | "mget"
  | "mset";

export type CacheOperationOutcome = "ok" | "error";
export type InvalidationOperation = "set" | "delete";

const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];

interface DurationState {
  buckets: number[];
  sum: number;
  count: number;
}

const operations = new Map<string, number>();
const durations = new Map<CacheOperation, DurationState>();
const invalidationPublishes = new Map<InvalidationOperation, number>();
let transactionRetries = 0;
let transactionRetryExhausted = 0;

function operationKey(op: CacheOperation, outcome: CacheOperationOutcome): string {
  return `${op}\u0000${outcome}`;
}

function durationState(op: CacheOperation): DurationState {
  let state = durations.get(op);
  if (!state) {
    state = { buckets: DURATION_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
    durations.set(op, state);
  }
  return state;
}

export function recordCacheOperation(
  op: CacheOperation,
  outcome: CacheOperationOutcome,
  durationMs: number,
): void {
  const key = operationKey(op, outcome);
  operations.set(key, (operations.get(key) ?? 0) + 1);
  const state = durationState(op);
  state.count += 1;
  state.sum += durationMs;
  for (const [index, bucket] of DURATION_BUCKETS_MS.entries()) {
    if (durationMs <= bucket) state.buckets[index]! += 1;
  }
}

export function recordInvalidationPublish(op: InvalidationOperation): void {
  invalidationPublishes.set(op, (invalidationPublishes.get(op) ?? 0) + 1);
}

export function recordTransactionRetry(): void {
  transactionRetries += 1;
}

export function recordTransactionRetryExhausted(): void {
  transactionRetryExhausted += 1;
}

export function resetPgredisMetrics(): void {
  operations.clear();
  durations.clear();
  invalidationPublishes.clear();
  transactionRetries = 0;
  transactionRetryExhausted = 0;
}

export interface PgredisMetricGauges {
  activeTenants: number;
  tenantCapacity: number;
  l1MaxEntries: number;
  l1Hits: number;
  l1Misses: number;
  l1NegativeHits: number;
  l1InflightReads: number;
  l1CoalescedReads: number;
  l1Bytes: number;
  l1PausedTenants: number;
  crossInstanceInvalidation: boolean;
  databaseInFlight: number;
  databaseLimit: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderDuration(op: CacheOperation, state: DurationState): string[] {
  const label = `op="${escapeLabel(op)}"`;
  const lines: string[] = [];
  for (const [index, bucket] of DURATION_BUCKETS_MS.entries()) {
    lines.push(
      `supacloud_pgredis_cache_operation_duration_ms_bucket{${label},le="${bucket}"} ${state.buckets[index]}`,
    );
  }
  lines.push(`supacloud_pgredis_cache_operation_duration_ms_bucket{${label},le="+Inf"} ${state.count}`);
  lines.push(`supacloud_pgredis_cache_operation_duration_ms_sum{${label}} ${state.sum}`);
  lines.push(`supacloud_pgredis_cache_operation_duration_ms_count{${label}} ${state.count}`);
  return lines;
}

export function renderPgredisMetrics(gauges: PgredisMetricGauges): string {
  const l1Reads = gauges.l1Hits + gauges.l1Misses;
  const lines: string[] = [
    "# HELP supacloud_pgredis_cache_operations_total Cache data-plane operations by op and outcome.",
    "# TYPE supacloud_pgredis_cache_operations_total counter",
  ];
  for (const [key, count] of [...operations.entries()].sort()) {
    const [op, outcome] = key.split("\u0000");
    lines.push(
      `supacloud_pgredis_cache_operations_total{op="${escapeLabel(op!)}",outcome="${escapeLabel(outcome!)}"} ${count}`,
    );
  }

  lines.push(
    "# HELP supacloud_pgredis_cache_operation_duration_ms Cache operation duration in milliseconds.",
    "# TYPE supacloud_pgredis_cache_operation_duration_ms histogram",
  );
  for (const [op, state] of [...durations.entries()].sort()) {
    lines.push(...renderDuration(op, state));
  }

  lines.push(
    "# HELP supacloud_pgredis_invalidation_publishes_total Cross-instance invalidation notifications published.",
    "# TYPE supacloud_pgredis_invalidation_publishes_total counter",
  );
  for (const [op, count] of [...invalidationPublishes.entries()].sort()) {
    lines.push(`supacloud_pgredis_invalidation_publishes_total{op="${escapeLabel(op)}"} ${count}`);
  }

  lines.push(
    "# HELP supacloud_pgredis_transaction_retries_total Transactions retried after a serialization failure.",
    "# TYPE supacloud_pgredis_transaction_retries_total counter",
    `supacloud_pgredis_transaction_retries_total ${transactionRetries}`,
    "# HELP supacloud_pgredis_transaction_retry_exhausted_total Transactions that exhausted serialization retries.",
    "# TYPE supacloud_pgredis_transaction_retry_exhausted_total counter",
    `supacloud_pgredis_transaction_retry_exhausted_total ${transactionRetryExhausted}`,
    "# HELP supacloud_pgredis_cross_instance_invalidation Whether cross-instance invalidation is enabled.",
    "# TYPE supacloud_pgredis_cross_instance_invalidation gauge",
    `supacloud_pgredis_cross_instance_invalidation ${gauges.crossInstanceInvalidation ? 1 : 0}`,
    "# HELP supacloud_pgredis_active_tenants Tenants with a live cache backend.",
    "# TYPE supacloud_pgredis_active_tenants gauge",
    `supacloud_pgredis_active_tenants ${gauges.activeTenants}`,
    "# HELP supacloud_pgredis_tenant_capacity Maximum number of tenant cache backends.",
    "# TYPE supacloud_pgredis_tenant_capacity gauge",
    `supacloud_pgredis_tenant_capacity ${gauges.tenantCapacity}`,
    "# HELP supacloud_pgredis_l1_max_entries Configured maximum L1 entries per tenant.",
    "# TYPE supacloud_pgredis_l1_max_entries gauge",
    `supacloud_pgredis_l1_max_entries ${gauges.l1MaxEntries}`,
    "# HELP supacloud_pgredis_l1_hits L1 read hits across tenant caches currently held.",
    "# TYPE supacloud_pgredis_l1_hits gauge",
    `supacloud_pgredis_l1_hits ${gauges.l1Hits}`,
    "# HELP supacloud_pgredis_l1_misses L1 read misses across tenant caches currently held.",
    "# TYPE supacloud_pgredis_l1_misses gauge",
    `supacloud_pgredis_l1_misses ${gauges.l1Misses}`,
    "# HELP supacloud_pgredis_l1_hit_ratio L1 hit ratio across tenant caches currently held (0 when no reads).",
    "# TYPE supacloud_pgredis_l1_hit_ratio gauge",
    `supacloud_pgredis_l1_hit_ratio ${l1Reads === 0 ? 0 : gauges.l1Hits / l1Reads}`,
    "# HELP supacloud_pgredis_l1_negative_hits Reads served from a cached L2 miss across tenant caches currently held.",
    "# TYPE supacloud_pgredis_l1_negative_hits gauge",
    `supacloud_pgredis_l1_negative_hits ${gauges.l1NegativeHits}`,
    "# HELP supacloud_pgredis_l1_inflight_reads Reads currently coalesced into an in-flight query.",
    "# TYPE supacloud_pgredis_l1_inflight_reads gauge",
    `supacloud_pgredis_l1_inflight_reads ${gauges.l1InflightReads}`,
    "# HELP supacloud_pgredis_l1_coalesced_reads Reads that joined an in-flight query for the same key.",
    "# TYPE supacloud_pgredis_l1_coalesced_reads gauge",
    `supacloud_pgredis_l1_coalesced_reads ${gauges.l1CoalescedReads}`,
    "# HELP supacloud_pgredis_l1_bytes Approximate bytes held across tenant L1 caches currently held.",
    "# TYPE supacloud_pgredis_l1_bytes gauge",
    `supacloud_pgredis_l1_bytes ${gauges.l1Bytes}`,
    "# HELP supacloud_pgredis_l1_paused_tenants Tenants whose L1 is paused because the invalidation listener is unhealthy.",
    "# TYPE supacloud_pgredis_l1_paused_tenants gauge",
    `supacloud_pgredis_l1_paused_tenants ${gauges.l1PausedTenants}`,
    "# HELP supacloud_pgredis_database_operations_in_flight Tenant database operations currently holding a budget permit.",
    "# TYPE supacloud_pgredis_database_operations_in_flight gauge",
    `supacloud_pgredis_database_operations_in_flight ${gauges.databaseInFlight}`,
    "# HELP supacloud_pgredis_database_operation_limit Aggregate database operation budget (0 means no explicit budget).",
    "# TYPE supacloud_pgredis_database_operation_limit gauge",
    `supacloud_pgredis_database_operation_limit ${gauges.databaseLimit}`,
  );

  return `${lines.join("\n")}\n`;
}