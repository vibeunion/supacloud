import { SQL } from "bun";
import { config } from "../config";
import { logger } from "../utils/logger";

// Parse DATABASE_URL to get components
function parseDatabaseUrl(url: string) {
  const urlMatch = url.match(/postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!urlMatch) {
    throw new Error("Invalid DATABASE_URL format");
  }
  const [, username, password, hostname, port, database] = urlMatch;
  return { hostname, port: parseInt(port, 10), database, username, password };
}

export const dbConfig = parseDatabaseUrl(config.databaseUrl);

// Create database connection - use explicit config to ensure database name is correct
export const sql = new SQL({
  hostname: dbConfig.hostname,
  port: dbConfig.port,
  database: dbConfig.database,
  username: dbConfig.username,
  password: dbConfig.password,
  max: 100,
  idleTimeout: 30,
  connectTimeout: 5000,
});

const MAX_CACHED_CONNECTIONS = 100;

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
        conn.sql.close().catch(e => logger.error(`Failed to close evicted connection ${oldestDbName}`, e));
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
    } catch (e) {
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
      command: (result as any).command || sqlQuery.trim().split(/\s+/)[0].toUpperCase(),
    };
  } catch (error) {
    throw new Error(`SQL execution error: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// Database operations wrapper
export const db = {
  sql,
  getProjectDb,
  executeQuery,
};

// Project status type
export type ProjectStatus = "creating" | "active" | "paused" | "deleted";

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
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type TaskType =
  | "provision_db"
  | "provision_s3"
  | "provision_runtime"
  | "provision_router"
  | "provision_gateway"
  | "cleanup_db"
  | "cleanup_s3"
  | "cleanup_runtime"
  | "cleanup_router";

export interface ProjectTask {
  id: string;
  project_ref: string;
  task_type: TaskType;
  status: TaskStatus;
  payload: Record<string, any>;
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
    } catch (e) {
      logger.error(`Failed to close cached connection for ${dbName} during shutdown`, e as Error);
    }
  }
  projectConnections.clear();
}
