import { SQL } from "bun";
import { config } from "../config";
import { logger } from "../utils/logger";

// 解析 DATABASE_URL 获取各组件
function parseDatabaseUrl(url: string) {
  const urlMatch = url.match(/postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!urlMatch) {
    throw new Error("Invalid DATABASE_URL format");
  }
  const [, username, password, hostname, port, database] = urlMatch;
  return { hostname, port: parseInt(port, 10), database, username, password };
}

const dbConfig = parseDatabaseUrl(config.databaseUrl);

// 创建数据库连接 - 使用显式配置确保数据库名正确
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

// 项目数据库连接缓存
const projectConnections: Map<string, { sql: SQL; lastUsed: number }> = new Map();

// 获取项目数据库连接
export function getProjectDb(dbName: string): SQL {
  const cached = projectConnections.get(dbName);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.sql;
  }

  // LRU 清理机制：超出最大连接数时清理最久未使用的连接
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

// 显式移除某个项目的缓存 (例如项目已被删除或暂停时)
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

// 执行 SQL 查询
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

// 数据库操作封装
export const db = {
  sql,
  getProjectDb,
  executeQuery,
};

// 项目状态类型
export type ProjectStatus = "creating" | "active" | "paused" | "deleted";

// 组织类型定义
export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

// 项目类型定义
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

// 任务状态与类型
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

// 创建项目输入类型
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

// 关闭数据库连接
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
