import { describe, expect, test } from "bun:test";
import {
  recordCacheOperation,
  recordInvalidationPublish,
  recordTransactionRetry,
  recordTransactionRetryExhausted,
  renderPgredisMetrics,
  resetPgredisMetrics,
} from "./metrics";

const gauges = {
  activeTenants: 3,
  tenantCapacity: 8,
  l1MaxEntries: 100,
  l1Hits: 9,
  l1Misses: 3,
  l1NegativeHits: 2,
  l1InflightReads: 1,
  l1CoalescedReads: 4,
  l1Bytes: 2_048,
  l1PausedTenants: 1,
  crossInstanceInvalidation: true,
  databaseInFlight: 5,
  databaseLimit: 40,
};

describe("pgredis metrics", () => {
  test("renders operation counters and the duration histogram", () => {
    resetPgredisMetrics();
    recordCacheOperation("get", "ok", 0.5);
    recordCacheOperation("get", "ok", 40);
    recordCacheOperation("mset", "error", 2);

    const text = renderPgredisMetrics(gauges);
    expect(text).toContain('supacloud_pgredis_cache_operations_total{op="get",outcome="ok"} 2');
    expect(text).toContain('supacloud_pgredis_cache_operations_total{op="mset",outcome="error"} 1');
    expect(text).toContain('supacloud_pgredis_cache_operation_duration_ms_count{op="get"} 2');
    expect(text).toContain('supacloud_pgredis_cache_operation_duration_ms_bucket{op="get",le="1"} 1');
    expect(text).toContain('supacloud_pgredis_cache_operation_duration_ms_bucket{op="get",le="50"} 2');
    expect(text).toContain('supacloud_pgredis_cache_operation_duration_ms_bucket{op="get",le="+Inf"} 2');
  });

  test("renders invalidation, retry and gauge series", () => {
    resetPgredisMetrics();
    recordInvalidationPublish("set");
    recordInvalidationPublish("set");
    recordInvalidationPublish("delete");
    recordTransactionRetry();
    recordTransactionRetryExhausted();

    const text = renderPgredisMetrics({ ...gauges, crossInstanceInvalidation: false });
    expect(text).toContain('supacloud_pgredis_invalidation_publishes_total{op="set"} 2');
    expect(text).toContain('supacloud_pgredis_invalidation_publishes_total{op="delete"} 1');
    expect(text).toContain("supacloud_pgredis_transaction_retries_total 1");
    expect(text).toContain("supacloud_pgredis_transaction_retry_exhausted_total 1");
    expect(text).toContain("supacloud_pgredis_cross_instance_invalidation 0");
    expect(text).toContain("supacloud_pgredis_active_tenants 3");
    expect(text).toContain("supacloud_pgredis_tenant_capacity 8");
    expect(text).toContain("supacloud_pgredis_l1_max_entries 100");
    expect(text).toContain("supacloud_pgredis_l1_hits 9");
    expect(text).toContain("supacloud_pgredis_l1_misses 3");
    expect(text).toContain("supacloud_pgredis_l1_hit_ratio 0.75");
    expect(text).toContain("supacloud_pgredis_l1_negative_hits 2");
    expect(text).toContain("supacloud_pgredis_l1_inflight_reads 1");
    expect(text).toContain("supacloud_pgredis_l1_coalesced_reads 4");
    expect(text).toContain("supacloud_pgredis_l1_bytes 2048");
    expect(text).toContain("supacloud_pgredis_l1_paused_tenants 1");
    expect(text).toContain("supacloud_pgredis_database_operations_in_flight 5");
    expect(text).toContain("supacloud_pgredis_database_operation_limit 40");
  });

  test("reports zero hit ratio when there were no L1 reads", () => {
    resetPgredisMetrics();
    const text = renderPgredisMetrics({ ...gauges, l1Hits: 0, l1Misses: 0 });
    expect(text).toContain("supacloud_pgredis_l1_hit_ratio 0");
  });

  test("resets all series", () => {
    recordCacheOperation("get", "ok", 1);
    recordInvalidationPublish("set");
    recordTransactionRetry();
    recordTransactionRetryExhausted();
    resetPgredisMetrics();

    const text = renderPgredisMetrics(gauges);
    expect(text).not.toContain("supacloud_pgredis_cache_operations_total{");
    expect(text).not.toContain("supacloud_pgredis_invalidation_publishes_total{");
    expect(text).toContain("supacloud_pgredis_transaction_retries_total 0");
    expect(text).toContain("supacloud_pgredis_transaction_retry_exhausted_total 0");
  });
});