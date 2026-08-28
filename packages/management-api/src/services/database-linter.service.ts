import type { SQL } from "bun";
import { normalizeDatabaseSchema } from "./database-governance-input";

export type LintSeverity = "danger" | "warning" | "info";
export type LintCategory = "security" | "performance" | "integrity";

export interface DatabaseLintIssue {
  type: string;
  severity: LintSeverity;
  category: LintCategory;
  schema_name: string;
  object_name: string;
  detail: string;
  recommendation: string;
  fix_sql: string;
  column_name?: string | null;
  column_names?: string[];
  identity_args?: string | null;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function schemaLiteral(targetSchema: string): string {
  return targetSchema.replaceAll("'", "''");
}

async function readMissingPrimaryKeyIssues(projectDb: SQL, targetSchema: string): Promise<DatabaseLintIssue[]> {
  const schema = schemaLiteral(targetSchema);
  const rows = await projectDb.unsafe(`
    SELECT
      t.table_schema,
      t.table_name
    FROM information_schema.tables t
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = t.table_schema
     AND tc.table_name = t.table_name
     AND tc.constraint_type = 'PRIMARY KEY'
    WHERE t.table_schema = '${schema}'
      AND t.table_type = 'BASE TABLE'
      AND tc.constraint_name IS NULL
    ORDER BY t.table_schema, t.table_name;
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const schema = String(row.table_schema);
    const table = String(row.table_name);
    return {
      type: "no_primary_key",
      severity: "danger",
      category: "integrity",
      schema_name: schema,
      object_name: table,
      detail: `Table ${schema}.${table} has no primary key defined.`,
      recommendation: "Add a primary key constraint or identity column to uniquely identify rows and enable replication.",
      fix_sql: `ALTER TABLE ${qualifiedName(schema, table)} ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY;`,
    };
  });
}

async function readMissingRlsIssues(projectDb: SQL, targetSchema: string): Promise<DatabaseLintIssue[]> {
  const schema = schemaLiteral(targetSchema);
  const rows = await projectDb.unsafe(`
    SELECT
      schemaname,
      tablename
    FROM pg_tables
    WHERE schemaname = '${schema}'
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = pg_tables.schemaname
          AND c.relname = pg_tables.tablename
          AND c.relrowsecurity = true
      )
    ORDER BY schemaname, tablename;
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const schema = String(row.schemaname);
    const table = String(row.tablename);
    return {
      type: "no_rls",
      severity: "warning",
      category: "security",
      schema_name: schema,
      object_name: table,
      detail: `Row Level Security (RLS) is not enabled on table ${schema}.${table}.`,
      recommendation: "Enable Row Level Security to prevent unauthorized access via PostgREST / Supabase Client.",
      fix_sql: `ALTER TABLE ${qualifiedName(schema, table)} ENABLE ROW LEVEL SECURITY;`,
    };
  });
}

async function readMissingForeignKeyIndexIssues(projectDb: SQL, targetSchema: string): Promise<DatabaseLintIssue[]> {
  const schema = schemaLiteral(targetSchema);
  const rows = await projectDb.unsafe(`
    SELECT
      ns.nspname AS table_schema,
      rel.relname AS table_name,
      ARRAY(
        SELECT att.attname
        FROM unnest(fk.conkey) WITH ORDINALITY AS key_col(attnum, ordinality)
        JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key_col.attnum
        ORDER BY key_col.ordinality
      ) AS column_names
    FROM pg_constraint fk
    JOIN pg_class rel ON rel.oid = fk.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE fk.contype = 'f'
      AND ns.nspname = '${schema}'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index idx
        WHERE idx.indrelid = fk.conrelid
          AND idx.indisvalid
          AND idx.indpred IS NULL
          AND idx.indnkeyatts >= cardinality(fk.conkey)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(fk.conkey) WITH ORDINALITY AS fk_col(attnum, ordinality)
            WHERE NOT EXISTS (
              SELECT 1
              FROM unnest(idx.indkey) WITH ORDINALITY AS idx_col(attnum, ordinality)
              WHERE idx_col.ordinality = fk_col.ordinality
                AND idx_col.attnum = fk_col.attnum
            )
          )
      )
    ORDER BY ns.nspname, rel.relname, fk.conname;
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const schema = String(row.table_schema);
    const table = String(row.table_name);
    const columns = Array.isArray(row.column_names) ? row.column_names.map(String) : [];
    const columnList = columns.map((column) => quoteIdent(column)).join(", ");
    return {
      type: "no_index_on_fk",
      severity: "info",
      category: "performance",
      schema_name: schema,
      object_name: table,
      column_names: columns,
      detail: `Foreign key columns ${columnList} on table ${schema}.${table} have no supporting index.`,
      recommendation: "Create an index on foreign key columns to improve JOIN and cascading operation performance.",
      fix_sql: `CREATE INDEX ON ${qualifiedName(schema, table)} (${columns.map(quoteIdent).join(", ")});`,
    };
  });
}

async function readUnsafeSecurityDefinerIssues(projectDb: SQL, targetSchema: string): Promise<DatabaseLintIssue[]> {
  const schema = schemaLiteral(targetSchema);
  const rows = await projectDb.unsafe(`
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef = true
      AND p.prokind = 'f'
      AND n.nspname = '${schema}'
      AND (
        p.proconfig IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=%'
        )
      )
    ORDER BY n.nspname, p.proname;
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const schema = String(row.schema_name);
    const funcName = String(row.function_name);
    const identityArgs = String(row.identity_args || "");
    return {
      type: "security_definer_no_search_path",
      severity: "danger",
      category: "security",
      schema_name: schema,
      object_name: funcName,
      identity_args: identityArgs,
      detail: `Function ${schema}.${funcName}(${identityArgs}) is SECURITY DEFINER but has no explicit search_path configured.`,
      recommendation: "Always set an explicit immutable search_path (e.g. search_path = pg_catalog) on SECURITY DEFINER functions to prevent privilege escalation via schema poisoning.",
      fix_sql: `ALTER FUNCTION ${qualifiedName(schema, funcName)}(${identityArgs}) SET search_path = pg_catalog;`,
    };
  });
}

export async function runDatabaseLinter(projectDb: SQL, targetSchema = "public"): Promise<DatabaseLintIssue[]> {
  const normalizedSchema = normalizeDatabaseSchema(targetSchema);
  const issueGroups = await Promise.all([
    readMissingPrimaryKeyIssues(projectDb, normalizedSchema),
    readMissingRlsIssues(projectDb, normalizedSchema),
    readMissingForeignKeyIndexIssues(projectDb, normalizedSchema),
    readUnsafeSecurityDefinerIssues(projectDb, normalizedSchema),
  ]);
  return issueGroups.flat();
}
