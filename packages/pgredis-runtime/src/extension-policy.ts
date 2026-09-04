export const PGREDIS_EXTENSION_POLICY = Object.freeze({
  required: [] as const,
  recommended: ["pg_stat_statements", "pg_cron"] as const,
  optional: ["pg_ivm"] as const,
});

export type PgredisExtensionPolicy = typeof PGREDIS_EXTENSION_POLICY;

/**
 * pgredis only needs PostgreSQL core features. Extensions improve operations or
 * higher-level aggregate workloads, but must never prevent the KV data plane
 * from starting on a supported PostgreSQL installation.
 */
export function pgredisExtensionPolicy(): PgredisExtensionPolicy {
  return PGREDIS_EXTENSION_POLICY;
}
