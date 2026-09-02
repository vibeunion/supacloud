/**
 * Catalog 读取：通过注入的 QueryExecutor 从 PostgreSQL 系统目录读取真实状态。
 * 所有 SQL 参数化（$1 = schemas 数组），默认只读 public schema。
 */

import type { PolicyOperation } from './module.js';

export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * 事务封装。回调收到的 executor 必须绑定到同一个数据库连接。
   * 只读 catalog 操作不要求实现；applyModulePlan 会 fail-closed。
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
  /** tgenabled !== 'D'（未被 disable） */
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

/** pg_policy.polcmd → 语义化操作名 */
const POLCMD_MAP: Record<string, PolicyOperation> = {
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
  '*': 'all',
};

/** 从 proconfig（text[]）中提取 search_path=... 配置，无则 null */
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
