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
    expect(config.maxValueBytes).toBe(1_048_576);
    expect(config.l1MaxEntries).toBe(1_000);
    expect(config.l1TtlMs).toBe(30_000);
    expect(config.capabilityMaxTtlMs).toBe(600_000);
  });

  test("rejects missing or short internal tokens", () => {
    expect(() => loadPgredisRuntimeConfig({})).toThrow("at least 32 bytes");
    expect(() => loadPgredisRuntimeConfig({
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "short",
    })).toThrow("at least 32 bytes");
  });
});
