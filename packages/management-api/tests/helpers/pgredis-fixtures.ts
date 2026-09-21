import type { PgredisPlatformStatus, PgredisProjectStatus } from "../../src/services/pgredis-runtime.service";

export function pgredisPlatformFixture(): PgredisPlatformStatus {
  return {
    configured: true,
    ok: true,
    service: "pgredis-runtime",
    namespace: "supacloud-edge-runtime",
    queue: false,
    rateLimit: false,
    extensions: { required: [], recommended: [], optional: [] },
    activeTenants: 0,
    maxTenants: 8,
    connectionsPerTenant: 2,
    l1: { enabled: true, maxEntries: 100, ttlMs: 1_000 },
    tenants: [],
  };
}

export function pgredisProjectFixture(projectRef: string): PgredisProjectStatus {
  return {
    projectRef,
    configured: true,
    active: false,
    configurationCurrent: true,
    leases: 0,
    lastUsedAt: null,
  };
}
