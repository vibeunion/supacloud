import { describe, expect, test } from "bun:test";
import { loadPgredisRuntimeConfig } from "./config";

describe("loadPgredisRuntimeConfig", () => {
  test("uses bounded defaults with a dedicated internal token", () => {
    const config = loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
    });
    expect(config.port).toBe(9_010);
    expect(config.connectionsPerTenant).toBe(2);
    expect(config.maxTenants).toBe(128);
    expect(config.maxTotalConnections).toBe(256);
    expect(config.maxValueBytes).toBe(1_048_576);
    expect(config.l1MaxEntries).toBe(1_000);
    expect(config.l1TtlMs).toBe(30_000);
    expect(config.cleanupIntervalMs).toBe(60_000);
    expect(config.cleanupBatchSize).toBe(500);
    expect(config.maxKeysPerRequest).toBe(100);
    expect(config.capabilityMaxTtlMs).toBe(600_000);
  });

  test("allows bounded batch key tuning", () => {
    const config = loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST: "250",
    });
    expect(config.maxKeysPerRequest).toBe(250);
    expect(() => loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST: "0",
    })).toThrow("PGREDIS_RUNTIME_MAX_KEYS_PER_REQUEST");
  });

  test("derives the aggregate connection budget from tenant capacity", () => {
    expect(loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_MAX_TENANTS: "10",
      PGREDIS_RUNTIME_CONNECTIONS_PER_TENANT: "4",
    }).maxTotalConnections).toBe(40);
    expect(loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_MAX_TOTAL_CONNECTIONS: "64",
    }).maxTotalConnections).toBe(64);
    expect(() => loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_MAX_TOTAL_CONNECTIONS: "0",
    })).toThrow("PGREDIS_RUNTIME_MAX_TOTAL_CONNECTIONS");
  });

  test("parses the single-instance invalidation flag", () => {
    expect(loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
    }).singleInstance).toBeFalse();
    expect(loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_SINGLE_INSTANCE: "true",
    }).singleInstance).toBeTrue();
    expect(loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_SINGLE_INSTANCE: "0",
    }).singleInstance).toBeFalse();
    expect(() => loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_SINGLE_INSTANCE: "maybe",
    })).toThrow("PGREDIS_RUNTIME_SINGLE_INSTANCE");
  });

  test("allows bounded expired-row cleanup tuning", () => {
    const config = loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "x".repeat(32),
      PGREDIS_RUNTIME_CLEANUP_INTERVAL_MS: "120000",
      PGREDIS_RUNTIME_CLEANUP_BATCH_SIZE: "250",
    });
    expect(config.cleanupIntervalMs).toBe(120_000);
    expect(config.cleanupBatchSize).toBe(250);
  });

  test("rejects missing or short internal tokens", () => {
    expect(() => loadPgredisRuntimeConfig({})).toThrow("at least 32 bytes");
    expect(() => loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "short",
    })).toThrow("at least 32 bytes");
  });
});
