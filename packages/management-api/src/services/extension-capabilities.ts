export type ExtensionLifecycle = "safe_toggle" | "stateful" | "admin_provisioned" | "workflow";
export type ExtensionBackupImpact = "none" | "application_data" | "extension_state" | "secrets_and_state";
export type ExtensionRollback = "drop_restrict" | "reviewed_migration" | "pause_only" | "admin_reprovision";
export type ExtensionSupport = "supported" | "optional" | "deprecated" | "unclassified";

export type ExtensionCapability = {
  lifecycle: ExtensionLifecycle;
  preload: string[];
  migration: "create_extension" | "reviewed_migration" | "admin_provisioning";
  backup: ExtensionBackupImpact;
  rls: "application_owned" | "extension_owned" | "platform_owned";
  resources: string[];
  rollback: ExtensionRollback;
  support: ExtensionSupport;
  notes: string;
};

const DEFAULT_CAPABILITY: ExtensionCapability = {
  lifecycle: "safe_toggle",
  preload: [],
  migration: "create_extension",
  backup: "application_data",
  rls: "application_owned",
  resources: [],
  rollback: "drop_restrict",
  support: "unclassified",
  notes: "Review the extension contract before enabling it for a production project.",
};

const CAPABILITIES: Record<string, ExtensionCapability> = {
  vector: {
    ...DEFAULT_CAPABILITY,
    support: "supported",
    resources: ["vector_index_memory", "embedding_dimension"],
    notes: "Benchmark HNSW or IVFFlat indexes on the target PostgreSQL version.",
  },
  pg_trgm: {
    ...DEFAULT_CAPABILITY,
    support: "supported",
    resources: ["gin_index_memory"],
    notes: "Use with tsvector/GIN for fuzzy and hybrid search; keep the RLS predicate in the RPC or table policy.",
  },
  postgis: {
    ...DEFAULT_CAPABILITY,
    support: "supported",
    resources: ["spatial_index_memory"],
    notes: "Spatial types and indexes remain application-owned data and need a query benchmark.",
  },
  pg_graphql: {
    ...DEFAULT_CAPABILITY,
    support: "supported",
    resources: ["graphql_depth", "graphql_complexity", "graphql_page_size"],
    notes: "Use the single pg_graphql executor and the project GraphQL policy; do not add a second resolver.",
  },
  pg_jsonschema: {
    ...DEFAULT_CAPABILITY,
    support: "supported",
    resources: ["schema_validation_cost"],
    notes: "Validation is part of the application migration contract.",
  },
  pgmq: {
    lifecycle: "stateful",
    preload: [],
    migration: "reviewed_migration",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["queue_storage", "consumer_concurrency", "visibility_timeout"],
    rollback: "reviewed_migration",
    support: "supported",
    notes: "Keep pgmq_public compatibility wrappers and at-least-once consumer semantics.",
  },
  pg_cron: {
    lifecycle: "stateful",
    preload: ["pg_cron"],
    migration: "reviewed_migration",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["scheduled_jobs", "job_concurrency"],
    rollback: "reviewed_migration",
    support: "supported",
    notes: "Do not use tenant pg_cron as a replacement for the platform cross-project scheduler.",
  },
  pg_net: {
    lifecycle: "stateful",
    preload: ["pg_net"],
    migration: "reviewed_migration",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["outbound_requests", "response_retention"],
    rollback: "reviewed_migration",
    support: "supported",
    notes: "Outbound targets still require the platform DNS/IP, timeout and response-size policy.",
  },
  supabase_vault: {
    lifecycle: "admin_provisioned",
    preload: ["supabase_vault", "pgsodium"],
    migration: "admin_provisioning",
    backup: "secrets_and_state",
    rls: "platform_owned",
    resources: ["secret_rotation", "key_material"],
    rollback: "admin_reprovision",
    support: "optional",
    notes: "The key loader must fail closed; plaintext secrets never appear in project configuration or responses.",
  },
  pgsodium: {
    lifecycle: "admin_provisioned",
    preload: ["pgsodium"],
    migration: "admin_provisioning",
    backup: "secrets_and_state",
    rls: "platform_owned",
    resources: ["key_material"],
    rollback: "admin_reprovision",
    support: "deprecated",
    notes: "Do not build new business APIs on pgsodium; prefer Vault with an external key-management process.",
  },
  wrappers: {
    lifecycle: "stateful",
    preload: [],
    migration: "reviewed_migration",
    backup: "secrets_and_state",
    rls: "platform_owned",
    resources: ["outbound_egress", "foreign_server_connections", "row_limits"],
    rollback: "reviewed_migration",
    support: "optional",
    notes: "Use Vault references, read-only defaults and an explicit egress policy for every foreign server.",
  },
  pg_stat_statements: {
    lifecycle: "admin_provisioned",
    preload: ["pg_stat_statements"],
    migration: "admin_provisioning",
    backup: "none",
    rls: "platform_owned",
    resources: ["query_statistics_memory"],
    rollback: "admin_reprovision",
    support: "supported",
    notes: "Expose only the platform compatibility views and redact query text where required.",
  },
  pgaudit: {
    lifecycle: "admin_provisioned",
    preload: ["pgaudit"],
    migration: "admin_provisioning",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["audit_log_volume"],
    rollback: "admin_reprovision",
    support: "supported",
    notes: "Audit retention and redaction are deployment policies, not project SQL privileges.",
  },
  pgflow: {
    lifecycle: "workflow",
    preload: [],
    migration: "reviewed_migration",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["worker_concurrency", "workflow_storage", "lease_timeout"],
    rollback: "pause_only",
    support: "supported",
    notes: "pgflow is a reviewed SQL/Worker component, not a CREATE EXTENSION package.",
  },
  pg_durable: {
    lifecycle: "admin_provisioned",
    preload: ["pg_durable"],
    migration: "admin_provisioning",
    backup: "extension_state",
    rls: "platform_owned",
    resources: ["durable_worker", "workflow_storage"],
    rollback: "admin_reprovision",
    support: "optional",
    notes: "Requires administrator preload, configured database and restart; it is not a tenant toggle.",
  },
};

export function extensionCapability(name: string): ExtensionCapability {
  const capability = CAPABILITIES[name] ?? DEFAULT_CAPABILITY;
  return {
    ...capability,
    preload: [...capability.preload],
    resources: [...capability.resources],
  };
}
