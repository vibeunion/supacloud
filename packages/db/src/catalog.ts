/**
 * Catalog reading: Reads real state from PostgreSQL system catalogs via injected QueryExecutor.
 * All SQL is parameterized ($1 = schemas array), defaulting to public schema.
 */

import type { PolicyOperation } from './module.js';

export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Optional transaction wrapper: When provided, apply wraps begin/commit/rollback with it;
   * when omitted, falls back to sequential begin/commit/rollback on executor (mock-friendly).
   */
  transaction?<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T>;
}

export interface CatalogTable {
  schema: string;
  name: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
}

export interface CatalogPolicy {
  schema: string;
  table: string;
  name: string;
  command: PolicyOperation;
  roles: string[];
  usingExpr?: string;
  checkExpr?: string;
}

export interface CatalogFunction {
  schema: string;
  name: string;
  security: 'invoker' | 'definer';
  searchPath: string | null;
  language: string;
}

export interface CatalogTrigger {
  schema: string;
  table: string;
  name: string;
  /** tgenabled !== 'D' (not disabled) */
  enabled: boolean;
}

export interface CatalogGrant {
  objectSchema: string;
  objectName: string;
  privilege: string;
  grantee: string;
}

export interface DatabaseCatalog {
  tables: CatalogTable[];
  policies: CatalogPolicy[];
  functions: CatalogFunction[];
  triggers: CatalogTrigger[];
  grants: CatalogGrant[];
}

const TABLES_SQL = `
SELECT n.nspname AS schema,
       c.relname AS name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = ANY($1)
ORDER BY n.nspname, c.relname
`;

const POLICIES_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table,
       p.polname AS name,
       p.polcmd AS command,
       ARRAY(
         SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END
         FROM unnest(p.polroles) AS r
       ) AS roles,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1)
ORDER BY n.nspname, c.relname, p.polname
`;

const FUNCTIONS_SQL = `
SELECT n.nspname AS schema,
       p.proname AS name,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       l.lanname AS language
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = ANY($1)
ORDER BY n.nspname, p.proname
`;

const TRIGGERS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table,
       t.tgname AS name,
       t.tgenabled <> 'D' AS enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname = ANY($1)
ORDER BY n.nspname, c.relname, t.tgname
`;

const GRANTS_SQL = `
SELECT table_schema AS object_schema,
       table_name AS object_name,
       privilege_type AS privilege,
       grantee
FROM information_schema.role_table_grants
WHERE table_schema = ANY($1)
UNION ALL
SELECT routine_schema AS object_schema,
       routine_name AS object_name,
       privilege_type AS privilege,
       grantee
FROM information_schema.routine_privileges
WHERE routine_schema = ANY($1)
`;

interface TableRow {
  schema: string;
  name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}

interface PolicyRow {
  schema: string;
  table: string;
  name: string;
  command: string;
  roles: string[] | null;
  using_expr: string | null;
  check_expr: string | null;
}

interface FunctionRow {
  schema: string;
  name: string;
  security_definer: boolean;
  config: string[] | null;
  language: string;
}

interface TriggerRow {
  schema: string;
  table: string;
  name: string;
  enabled: boolean;
}

interface GrantRow {
  object_schema: string;
  object_name: string;
  privilege: string;
  grantee: string;
}

/** pg_policy.polcmd -> semantic operation name */
const POLCMD_MAP: Record<string, PolicyOperation> = {
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
  '*': 'all',
};

/** Extracts search_path=... setting from proconfig (text[]), or null if unset */
export function extractSearchPath(config: string[] | null): string | null {
  if (!config) return null;
  const entry = config.find((item) => item.startsWith('search_path='));
  if (!entry) return null;
  return entry.slice('search_path='.length);
}

export async function readCatalog(
  executor: QueryExecutor,
  schemas: string[] = ['public'],
): Promise<DatabaseCatalog> {
  const params = [schemas];
  const [tableRows, policyRows, functionRows, triggerRows, grantRows] = await Promise.all([
    executor.query<TableRow>(TABLES_SQL, params),
    executor.query<PolicyRow>(POLICIES_SQL, params),
    executor.query<FunctionRow>(FUNCTIONS_SQL, params),
    executor.query<TriggerRow>(TRIGGERS_SQL, params),
    executor.query<GrantRow>(GRANTS_SQL, params),
  ]);

  return {
    tables: tableRows.map((row) => ({
      schema: row.schema,
      name: row.name,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
    })),
    policies: policyRows.map((row) => ({
      schema: row.schema,
      table: row.table,
      name: row.name,
      command: POLCMD_MAP[row.command] ?? 'all',
      roles: row.roles ?? [],
      usingExpr: row.using_expr ?? undefined,
      checkExpr: row.check_expr ?? undefined,
    })),
    functions: functionRows.map((row) => ({
      schema: row.schema,
      name: row.name,
      security: row.security_definer ? 'definer' : 'invoker',
      searchPath: extractSearchPath(row.config),
      language: row.language,
    })),
    triggers: triggerRows.map((row) => ({
      schema: row.schema,
      table: row.table,
      name: row.name,
      enabled: row.enabled,
    })),
    grants: grantRows.map((row) => ({
      objectSchema: row.object_schema,
      objectName: row.object_name,
      privilege: row.privilege,
      grantee: row.grantee,
    })),
  };
}
