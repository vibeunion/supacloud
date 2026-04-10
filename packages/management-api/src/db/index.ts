import { SQL } from "bun";
import { config } from "../config";
import { logger } from "../utils/logger";

// Parse DATABASE_URL to get components
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

// Create database connection - use explicit config to ensure database name is correct
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

const MAX_CACHED_CONNECTIONS = 20;

// Project database connection cache
const projectConnections: Map<string, { sql: SQL; lastUsed: number }> = new Map();

// Get project database connection
export function getProjectDb(dbName: string): SQL {
  const cached = projectConnections.get(dbName);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.sql;
  }

  // LRU cleanup: evict least recently used connection when exceeding max connections
  if (projectConnections.size >= MAX_CACHED_CONNECTIONS) {
    let oldestDbName = "";
    let oldestTime = Infinity;

    for (const [key, value] of projectConnections.entries()) {
      if (value.lastUsed < oldestTime) {
        oldestTime = value.lastUsed;
        oldestDbName = key;
      }
    }

    if (oldestDbName) {
      const conn = projectConnections.get(oldestDbName);
      if (conn) {
        logger.debug(`Evicting project connection cache for ${oldestDbName} due to limit.`);
        conn.sql.close().catch(e => logger.error(`Failed to close evicted connection ${oldestDbName}`, { error: e instanceof Error ? e.message : String(e) }));
      }
      projectConnections.delete(oldestDbName);
    }
  }

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

// Explicitly remove cache for a project (e.g., when project is deleted or paused)
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
}

// Execute SQL query
export async function executeQuery(dbName: string, sqlQuery: string): Promise<{ rows: unknown[]; rowCount: number; command: string }> {
  const projectDb = getProjectDb(dbName);
  try {
    const result = await projectDb.unsafe(sqlQuery);
    return {
      rows: result as unknown[],
      rowCount: result.length,
      command: ((result as unknown as Record<string, unknown>).command as string) || sqlQuery.trim().split(/\s+/)[0].toUpperCase(),
    };
  } catch (error: unknown) {
    throw new Error(`SQL execution error: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// Database operations wrapper
export const db = {
  sql,
  getProjectDb,
  executeQuery,
};

// --- Graceful Degradation ---

/** Check if the main database connection is healthy */
export async function isDbHealthy(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a database operation with exponential backoff retry.
 * On failure, retries up to `maxRetries` times with increasing delays.
 * Useful for transient connection failures (e.g., PostgreSQL restart).
 */
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
        throw error; // Non-retriable error or exhausted retries
      }

      const delay = baseDelayMs * Math.pow(4, attempt); // 100ms → 400ms → 1600ms
      logger.warn(`[DB] ${label} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`, {
        error: error instanceof Error ? error.message : String(error)
      });
      await Bun.sleep(delay);
    }
  }

  throw new Error(`[DB] ${label} exhausted all ${maxRetries} retries`);
}

// Project status type
export const ProjectStatus = {
  CREATING: "creating",
  ACTIVE: "active",
  PAUSED: "paused",
  DELETED: "deleted",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

// Organization type definition
export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

// Project type definition
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
  s3_bucket: string;
  s3_access_key: string | null;
  s3_secret_key: string | null;
  region: string;
  status: ProjectStatus;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// Task status and type
export const TaskStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
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
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export interface ProjectTask {
  id: string;
  project_ref: string;
  task_type: TaskType;
  status: TaskStatus;
  payload: Record<string, unknown>;
  error: string | null;
  retries: number;
  created_at: Date;
  updated_at: Date;
}

// Create project input type
export interface CreateProjectInput {
  ref: string;
  name: string;
  db_name: string;
  db_user: string;
  db_password: string;
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  s3_bucket: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  region?: string;
  config?: Record<string, unknown>;
}

// Close database connection
export async function closeDb() {
  await sql.close();

  // Clean up all cached project connections
  for (const [dbName, cached] of projectConnections.entries()) {
    try {
      await cached.sql.close();
    } catch (e: unknown) {
      logger.error(`Failed to close cached connection for ${dbName} during shutdown`, e as Error);
    }
  }
  projectConnections.clear();
}
