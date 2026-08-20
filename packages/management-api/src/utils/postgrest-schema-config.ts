import { createHash } from "node:crypto";
import { normalizeProjectConfig } from "./project-config";

export const BASE_POSTGREST_SCHEMAS = ["public", "storage", "graphql_public"] as const;
export const MAX_CUSTOM_POSTGREST_SCHEMAS = 16;

const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_SCHEMAS = new Set([
  ...BASE_POSTGREST_SCHEMAS,
  "auth",
  "extensions",
  "information_schema",
  "pg_catalog",
  "pgmq",
  "pgmq_public",
  "realtime",
  "supabase_migrations",
  "vault",
]);

export class PostgrestSchemaConfigError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_POSTGREST_SCHEMAS",
  ) {
    super(message);
    this.name = "PostgrestSchemaConfigError";
  }
}

export function normalizeCustomPostgrestSchemas(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PostgrestSchemaConfigError("exposed_schemas must be an array of schema names");
  }
  if (value.length > MAX_CUSTOM_POSTGREST_SCHEMAS) {
    throw new PostgrestSchemaConfigError(
      `exposed_schemas cannot contain more than ${MAX_CUSTOM_POSTGREST_SCHEMAS} schemas`,
    );
  }

  const normalized = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new PostgrestSchemaConfigError("exposed_schemas must contain only strings");
    }
    const schema = entry.trim().toLowerCase();
    if (!SCHEMA_NAME_PATTERN.test(schema)) {
      throw new PostgrestSchemaConfigError(`Invalid PostgREST schema name: ${entry}`);
    }
    if (RESERVED_SCHEMAS.has(schema) || schema.startsWith("pg_")
      || schema.startsWith("supabase_") || schema.startsWith("supacloud_")) {
      throw new PostgrestSchemaConfigError(`Schema is reserved by the platform: ${schema}`);
    }
    return schema;
  });

  return [...new Set(normalized)].sort();
}

export function projectCustomPostgrestSchemas(projectConfig: unknown): string[] {
  const config = normalizeProjectConfig(projectConfig);
  const postgrest = config.postgrest;
  if (!postgrest || typeof postgrest !== "object" || Array.isArray(postgrest)) return [];
  return normalizeCustomPostgrestSchemas((postgrest as Record<string, unknown>).exposed_schemas);
}

export function effectivePostgrestSchemas(
  customSchemas: readonly string[],
  includePgmqPublic = false,
): string[] {
  return [
    ...BASE_POSTGREST_SCHEMAS,
    ...(includePgmqPublic ? ["pgmq_public"] : []),
    ...customSchemas,
  ];
}

export function postgrestSchemasRevision(customSchemas: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...customSchemas])).digest("hex");
}
