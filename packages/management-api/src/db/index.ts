import { SQL } from "bun";
import { config } from "../config";
import { logger } from "../utils/logger";

function parseDatabaseUrl(url: string) {
  const urlMatch = url.match(/postgresql?:\/\/([^:]+)(?::([^@]*))?@([^:]*):(\d+)\/(.+)/);
  if (!urlMatch) {
    throw new Error(`Invalid DATABASE_URL format: ${url}`);
  }
  const [, username, password, hostname, port, database] = urlMatch;
  return {
    hostname: hostname || "localhost",
    port: parseInt(port, 10),
    database,
    username,
    password: password || ""
  };
}

export const dbConfig = parseDatabaseUrl(config.databaseUrl);

export const sql = new SQL({
  hostname: dbConfig.hostname,
  port: dbConfig.port,
  database: dbConfig.database,
  username: dbConfig.username,
  password: dbConfig.password,
  max: 20,
  idleTimeout: 30,
  connectTimeout: 5000,
});

const MAX_CACHED_CONNECTIONS = 50;

const projectConnections: Map<string, { sql: SQL; lastUsed: number }> = new Map();
const projectRoleConnections: Map<string, { sql: SQL; lastUsed: number }> = new Map();

const IDLE_SWEEP_INTERVAL = 60_000;
const MAX_CONNECTION_AGE = 30 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [dbName, cached] of projectConnections.entries()) {
    if (now - cached.lastUsed > MAX_CONNECTION_AGE) {
      logger.debug(`[DB Pool] Closing idle connection for ${dbName} (age: ${Math.round((now - cached.lastUsed) / 60000)}min)`);
      cached.sql.close().catch(e =>
        logger.error(`Failed to close idle connection ${dbName}`, { error: e instanceof Error ? e.message : String(e) })
      );
      projectConnections.delete(dbName);
    }
  }
  for (const [key, cached] of projectRoleConnections.entries()) {
    if (now - cached.lastUsed > MAX_CONNECTION_AGE) {
      logger.debug(`[DB Pool] Closing idle role connection for ${key} (age: ${Math.round((now - cached.lastUsed) / 60000)}min)`);
      cached.sql.close().catch(e =>
        logger.error(`Failed to close idle role connection ${key}`, { error: e instanceof Error ? e.message : String(e) })
      );
      projectRoleConnections.delete(key);
    }
  }
}, IDLE_SWEEP_INTERVAL).unref();

function evictOldestConnection(connections: Map<string, { sql: SQL; lastUsed: number }>, label: string) {
  if (connections.size < MAX_CACHED_CONNECTIONS) return;

  let oldestKey = "";
  let oldestTime = Infinity;

  for (const [key, value] of connections.entries()) {
    if (value.lastUsed < oldestTime) {
      oldestTime = value.lastUsed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const conn = connections.get(oldestKey);
    if (conn) {
      logger.debug(`Evicting ${label} connection cache for ${oldestKey} due to limit.`);
      conn.sql.close().catch(e => logger.error(`Failed to close evicted ${label} connection ${oldestKey}`, { error: e instanceof Error ? e.message : String(e) }));
    }
    connections.delete(oldestKey);
  }
}

export function getProjectDb(dbName: string): SQL {
  const cached = projectConnections.get(dbName);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.sql;
  }

  evictOldestConnection(projectConnections, "project admin");

  const projectSql = new SQL({
    hostname: dbConfig.hostname,
    port: dbConfig.port,
    database: dbName,
    username: dbConfig.username,
    password: dbConfig.password,
    max: 10,
    idleTimeout: 30,
    connectTimeout: 5000,
  });

  projectConnections.set(dbName, { sql: projectSql, lastUsed: Date.now() });
  return projectSql;
}

export function getProjectRoleDb(dbName: string, username: string, password: string): SQL {
  const key = `${dbName}:${username}`;
  const cached = projectRoleConnections.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.sql;
  }

  evictOldestConnection(projectRoleConnections, "project role");

  const projectSql = new SQL({
    hostname: dbConfig.hostname,
    port: dbConfig.port,
    database: dbName,
    username,
    password,
    max: 5,
    idleTimeout: 30,
    connectTimeout: 5000,
  });

  projectRoleConnections.set(key, { sql: projectSql, lastUsed: Date.now() });
  return projectSql;
}

const dbNameCache = new Map<string, { name: string; cachedAt: number }>();
const DB_NAME_CACHE_TTL = 5 * 60 * 1000;

export async function resolveDbName(ref: string): Promise<string> {
  const cached = dbNameCache.get(ref);
  if (cached && (Date.now() - cached.cachedAt) < DB_NAME_CACHE_TTL) return cached.name;

  try {
    const [row] = await sql`SELECT db_name FROM projects WHERE ref = ${ref} LIMIT 1`;
    if (row?.db_name) {
      dbNameCache.set(ref, { name: row.db_name, cachedAt: Date.now() });
      return row.db_name;
    }
  } catch {}
  const fallback = generateDbName(ref);
  return fallback;
}

export function invalidateDbNameCache(ref: string) {
  dbNameCache.delete(ref);
}

export function resolveBucketName(ref: string): string {
  return `supa-${ref}`;
}

export function resolveRoleName(ref: string): string {
  return `role_${ref}`;
}

export function resolveAuthenticatorName(ref: string): string {
  return `authenticator_${ref}`;
}

export function resolveSlotName(ref: string): string {
  return `supabase_realtime_${ref}`;
}

export function resolvePgrstChannel(ref: string): string {
  return `pgrst_${ref}`;
}

export function generateDbName(ref: string): string {
  return `supa_${ref}`;
}

export async function removeProjectDbCache(dbName: string) {
  const cached = projectConnections.get(dbName);
  if (cached) {
    try {
      await cached.sql.close();
    } catch (e: unknown) {
      logger.error(`Failed to close connection for ${dbName} during cache removal`, e as Error);
    }
    projectConnections.delete(dbName);
  }

  for (const [key, roleCached] of projectRoleConnections.entries()) {
    if (key.startsWith(`${dbName}:`)) {
      try {
        await roleCached.sql.close();
      } catch (e: unknown) {
        logger.error(`Failed to close role connection for ${key} during cache removal`, e as Error);
      }
      projectRoleConnections.delete(key);
    }
  }
}

export class PgError extends Error {
  code?: string;
  details?: string;
  hint?: string;
  constructor(message: string, code?: string, details?: string, hint?: string) {
    super(message);
    this.name = "PgError";
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

export type SqlExecutionMode = "read" | "migration" | "admin";

const WRITE_SQL_PATTERN = /^\s*(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|REINDEX|VACUUM|ANALYZE|REFRESH|CALL|DO|COPY|SET|RESET|LOCK)\b/i;
const MULTI_STATEMENT_PATTERN = /;\s*\S/;

const DANGEROUS_SQL_PATTERNS = [
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\s+public\b/i,
  /\bDROP\s+OWNED\b/i,
  /\bDROP\s+(TABLE|ROLE|USER)\b/i,
  /\bREASSIGN\s+OWNED\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bALTER\s+(ROLE|USER|SYSTEM)\b/i,
  /\bCREATE\s+(FUNCTION|PROCEDURE|RULE)\b/i,
  /\bDO\s+\$[^$]*\$/i,
  /\bCOPY\s+.*\bTO\s+PROGRAM\b/i,
  /\bCOPY\s+.*\bFROM\s+PROGRAM\b/i,
  /\bdblink_(connect|exec|open|fetch|send_query)\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bLOAD\b/i,
  /\bpg_execute_server_program\b/i,
  /\bpg_read_file\b/i,
  /\bpg_write_file\b/i,
  /\bpg_ls_dir\b/i,
  /\bpg_stat_file\b/i,
  /\bpg_terminate_backend\b/i,
  /\bpg_cancel_backend\b/i,
  /\bpg_catalog\b.*\bpg_read_file\b/i,
  /\bpg_catalog\b.*\bpg_write_file\b/i,
  /\bpg_catalog\b.*\bpg_execute_server_program\b/i,
];

function normalizeSqlForPolicy(sqlQuery: string): string {
  return sqlQuery
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDangerousSQL(sqlQuery: string): boolean {
  const normalized = normalizeSqlForPolicy(sqlQuery);
  return DANGEROUS_SQL_PATTERNS.some(pattern => pattern.test(normalized));
}

function assertSqlExecutionAllowed(sqlQuery: string, mode: SqlExecutionMode) {
  const normalized = normalizeSqlForPolicy(sqlQuery);
  if (!normalized) {
    throw new PgError("Query is empty", "42601");
  }

  if (mode === "read") {
    if (MULTI_STATEMENT_PATTERN.test(normalized) || WRITE_SQL_PATTERN.test(normalized) || !/^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(normalized)) {
      throw new PgError("Read-only SQL endpoint only allows SELECT, WITH, EXPLAIN, or SHOW statements. Use the migration endpoint for schema/data changes.", "42501");
    }
  }

  if (mode !== "admin" && isDangerousSQL(normalized)) {
    throw new PgError(
      "Query contains disallowed privileged operation. Use an explicitly authorized admin path for privileged maintenance.",
      "42501"
    );
  }
}

export type SqlExecutionResult = {
  rows: unknown[];
  rowCount: number;
  command: string;
  fields?: string[];
  notices?: string[];
};

function inferSqlCommand(sqlQuery: string): string {
  return sqlQuery.trim().split(/\s+/)[0]?.toUpperCase() || "SQL";
}

function normalizeSqlExecutionResult(sqlQuery: string, result: unknown): SqlExecutionResult {
  const rows = Array.isArray(result) ? result as unknown[] : [];
  const metadata = result as {
    command?: unknown;
    count?: unknown;
    rowCount?: unknown;
  };
  const metadataRowCount = Number(metadata?.rowCount ?? metadata?.count);
  const firstRow = rows[0];
  const fields =
    firstRow && typeof firstRow === "object" && !Array.isArray(firstRow)
      ? Object.keys(firstRow as Record<string, unknown>)
      : undefined;

  return {
    rows,
    rowCount: Number.isFinite(metadataRowCount) ? metadataRowCount : rows.length,
    command: typeof metadata?.command === "string" && metadata.command
      ? metadata.command
      : inferSqlCommand(sqlQuery),
    ...(fields ? { fields } : {}),
    notices: [],
  };
}

export async function executeQuery(
  dbName: string,
  sqlQuery: string,
  opts: { mode?: SqlExecutionMode; username?: string; password?: string } = {},
): Promise<SqlExecutionResult> {
  const mode = opts.mode || "read";
  assertSqlExecutionAllowed(sqlQuery, mode);

  const projectDb = opts.username && opts.password
    ? getProjectRoleDb(dbName, opts.username, opts.password)
    : getProjectDb(dbName);
  try {
    const result = await projectDb.unsafe(sqlQuery);
    return normalizeSqlExecutionResult(sqlQuery, result);
  } catch (error: unknown) {
    const pgError = error as Record<string, unknown>;
    throw new PgError(
      (pgError.message as string) || "Unknown error",
      pgError.code as string | undefined,
      pgError.details as string | undefined,
      pgError.hint as string | undefined,
    );
  }
}

export const db = {
  sql,
  getProjectDb,
  getProjectRoleDb,
  executeQuery,
};

export async function isDbHealthy(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 100, label = "db operation" } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isConnectionError = error instanceof Error && (
        error.message.includes("connection") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("timeout") ||
        error.message.includes("Connection terminated")
      ) && !(error instanceof Error && error.message.includes("no pg_hba.conf"));

      if (!isConnectionError || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(4, attempt);
      logger.warn(`[DB] ${label} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`, {
        error: error instanceof Error ? error.message : String(error)
      });
      await Bun.sleep(delay);
    }
  }

  throw new Error(`[DB] ${label} exhausted all ${maxRetries} retries`);
}

export const ProjectStatus = {
  CREATING: "creating",
  ACTIVE: "active",
  PAUSED: "paused",
  DELETED: "deleted",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan?: string | null;
  owner_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  user_id: string | null;
  invited_at: Date | string | null;
  joined_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Project {
  id: string;
  ref: string;
  organization_id: string;
  name: string;
  db_name: string;
  db_user: string;
  db_password: string;
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  publishable_key?: string | null;
  secret_key_hash?: string | null;
  secret_key_encrypted?: string | null;
  s3_bucket: string;
  s3_access_key: string | null;
  s3_secret_key: string | null;
  region: string;
  status: ProjectStatus;
  postgrest_desired: string | null;
  postgrest_actual: string | null;
  postgrest_health: string | null;
  postgrest_port: number | null;
  postgrest_last_error: string | null;
  postgrest_updated_at: Date | string | null;
  postgrest_last_reconciled_at: Date | string | null;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const TaskStatus = {
  PENDING: "pending",
  LEASED: "leased",
  RUNNING: "running",
  RETRY_SCHEDULED: "retry_scheduled",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DEAD_LETTERED: "dead_lettered",
  CANCELLED: "cancelled",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskType = {
  PROVISION_DB: "provision_db",
  PROVISION_S3: "provision_s3",
  PROVISION_RUNTIME: "provision_runtime",
  PROVISION_REALTIME: "provision_realtime",
  PROVISION_ROUTER: "provision_router",
  PROVISION_GATEWAY: "provision_gateway",
  PROVISION_SECRETS: "provision_secrets",
  CLEANUP_DB: "cleanup_db",
  CLEANUP_S3: "cleanup_s3",
  CLEANUP_RUNTIME: "cleanup_runtime",
  CLEANUP_REALTIME: "cleanup_realtime",
  CLEANUP_ROUTER: "cleanup_router",
  EDGE_FUNCTION: "edge_function",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType] | (string & {});

export interface ProjectTask {
  id: string;
  project_ref: string;
  task_type: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  error: string | null;
  retries: number;
  attempt: number;
  max_attempts: number;
  next_run_at: Date | null;
  lease_until: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  timeout_sec: number | null;
  idempotency_key: string | null;
  trace_id: string | null;
  cancel_requested_at: Date | null;
  cancellation_reason: string | null;
  correlation_id: string | null;
  business_task_id: string | null;
  metadata: Record<string, unknown> | null;
  function_slug: string | null;
  function_version: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectTaskAttempt {
  id: string;
  task_id: string;
  project_ref: string;
  attempt_no: number;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  response_status: number | null;
  logs: Array<{
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProjectInput {
  ref: string;
  name: string;
  db_name: string;
  db_user: string;
  db_password: string;
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  publishable_key?: string;
  secret_key?: string;
  s3_bucket: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  region?: string;
  config?: Record<string, unknown>;
}

export async function closeDb() {
  await sql.close();

  for (const [dbName, cached] of projectConnections.entries()) {
    try {
      await cached.sql.close();
    } catch (e: unknown) {
      logger.error(`Failed to close cached connection for ${dbName} during shutdown`, e as Error);
    }
  }
  projectConnections.clear();

  for (const [key, cached] of projectRoleConnections.entries()) {
    try {
      await cached.sql.close();
    } catch (e: unknown) {
      logger.error(`Failed to close cached role connection for ${key} during shutdown`, e as Error);
    }
  }
  projectRoleConnections.clear();
}
