import { SQL } from "bun";
import { config } from "../config";

// 创建数据库连接
export const sql = new SQL({
  url: config.databaseUrl,
  max: 100, // 维持稳定数量
  idleTimeout: 30, // 较短的空闲以保持活跃
  connectTimeout: 5000,
});

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
  organization_id: string; // 关联组织
  name: string;
  // ... 其他保持不变
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
  | "provision_router"
  | "provision_gateway"
  | "cleanup_db"
  | "cleanup_s3"
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
}
