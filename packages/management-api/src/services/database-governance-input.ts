const PG_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeSchemaIdentifier(value: string): string {
  const schema = value.trim();
  if (!PG_IDENTIFIER_PATTERN.test(schema) || schema.length > 63) {
    throw new Error("schema must be a PostgreSQL identifier of at most 63 characters");
  }
  return schema;
}

export function normalizeDatabaseSchema(value: string | undefined, fallback = "public"): string {
  return normalizeSchemaIdentifier(value ?? fallback);
}

export function normalizeRpcSchemas(schemas: readonly string[] | undefined): string[] {
  const values = schemas && schemas.length > 0 ? schemas : ["public", "api"];
  if (values.length > 16) {
    throw new Error("schemas must contain at most 16 PostgreSQL identifiers of at most 63 characters");
  }
  try {
    return [...new Set(values.map(normalizeSchemaIdentifier))];
  } catch {
    throw new Error("schemas must contain at most 16 PostgreSQL identifiers of at most 63 characters");
  }
}
