export interface PgredisRuntimeConfig {
  host: string;
  port: number;
  internalToken: string;
  tenantsDir: string;
  maxRequestBodyBytes: number;
  maxValueBytes: number;
  maxTtlMs: number;
  maxTenants: number;
  connectionsPerTenant: number;
  tenantIdleMs: number;
  l1MaxEntries: number;
  l1TtlMs: number;
  cleanupIntervalMs: number;
  cleanupBatchSize: number;
  capabilityMaxTtlMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadPgredisRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): PgredisRuntimeConfig {
  const internalToken = env.PGREDIS_RUNTIME_INTERNAL_TOKEN?.trim() || "";
  if (new TextEncoder().encode(internalToken).byteLength < 32) {
    throw new Error("PGREDIS_RUNTIME_INTERNAL_TOKEN must contain at least 32 bytes");
  }

  const maxValueBytes = positiveInteger(
    env.PGREDIS_RUNTIME_MAX_VALUE_BYTES,
    1_048_576,
    "PGREDIS_RUNTIME_MAX_VALUE_BYTES",
  );

  return {
    host: env.PGREDIS_RUNTIME_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.PGREDIS_RUNTIME_PORT || env.PORT, 9_010, "PGREDIS_RUNTIME_PORT"),
    internalToken,
    tenantsDir: env.PGREDIS_RUNTIME_TENANTS_DIR?.trim() || "/etc/supabase/pgredis-tenants",
    maxRequestBodyBytes: positiveInteger(
      env.PGREDIS_RUNTIME_MAX_REQUEST_BODY_BYTES,
      maxValueBytes + 65_536,
      "PGREDIS_RUNTIME_MAX_REQUEST_BODY_BYTES",
    ),
    maxValueBytes,
    maxTtlMs: positiveInteger(
      env.PGREDIS_RUNTIME_MAX_TTL_MS,
      31_536_000_000,
      "PGREDIS_RUNTIME_MAX_TTL_MS",
    ),
    maxTenants: positiveInteger(env.PGREDIS_RUNTIME_MAX_TENANTS, 128, "PGREDIS_RUNTIME_MAX_TENANTS"),
    connectionsPerTenant: positiveInteger(
      env.PGREDIS_RUNTIME_CONNECTIONS_PER_TENANT,
      2,
      "PGREDIS_RUNTIME_CONNECTIONS_PER_TENANT",
    ),
    tenantIdleMs: positiveInteger(
      env.PGREDIS_RUNTIME_TENANT_IDLE_MS,
      300_000,
      "PGREDIS_RUNTIME_TENANT_IDLE_MS",
    ),
    l1MaxEntries: positiveInteger(
      env.PGREDIS_RUNTIME_L1_MAX_ENTRIES,
      1_000,
      "PGREDIS_RUNTIME_L1_MAX_ENTRIES",
    ),
    l1TtlMs: positiveInteger(
      env.PGREDIS_RUNTIME_L1_TTL_MS,
      30_000,
      "PGREDIS_RUNTIME_L1_TTL_MS",
    ),
    cleanupIntervalMs: positiveInteger(
      env.PGREDIS_RUNTIME_CLEANUP_INTERVAL_MS,
      60_000,
      "PGREDIS_RUNTIME_CLEANUP_INTERVAL_MS",
    ),
    cleanupBatchSize: positiveInteger(
      env.PGREDIS_RUNTIME_CLEANUP_BATCH_SIZE,
      500,
      "PGREDIS_RUNTIME_CLEANUP_BATCH_SIZE",
    ),
    capabilityMaxTtlMs: positiveInteger(
      env.PGREDIS_RUNTIME_CAPABILITY_MAX_TTL_MS,
      600_000,
      "PGREDIS_RUNTIME_CAPABILITY_MAX_TTL_MS",
    ),
  };
}
