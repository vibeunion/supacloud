import { config } from "../config";
import { SQL } from "bun";

export async function initDatabase() {
  console.log("Initializing database...");
  console.log("DATABASE_URL:", config.databaseUrl.replace(/:[^:@]+@/, ":****@"));

  // 解析 DATABASE_URL 获取各组件
  const dbUrl = config.databaseUrl;
  const urlMatch = dbUrl.match(/postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  
  if (!urlMatch) {
    throw new Error("Invalid DATABASE_URL format");
  }
  
  const [, username, password, hostname, port, database] = urlMatch;
  console.log(`Connecting to database: ${database} on ${hostname}:${port}`);

  const ddlQuery = `
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ref VARCHAR(20) UNIQUE NOT NULL,
      organization_id UUID REFERENCES organizations(id),
      name VARCHAR(100) NOT NULL,
      db_name VARCHAR(63) NOT NULL,
      db_user VARCHAR(63) NOT NULL,
      db_password VARCHAR(100) NOT NULL,
      jwt_secret VARCHAR(100) NOT NULL,
      anon_key TEXT NOT NULL,
      service_role_key TEXT NOT NULL,
      s3_bucket VARCHAR(63) NOT NULL,
      s3_access_key VARCHAR(100),
      s3_secret_key VARCHAR(100),
      region VARCHAR(50) DEFAULT 'local',
      status VARCHAR(20) DEFAULT 'creating',
      config JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_projects_ref ON projects(ref);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

    CREATE TABLE IF NOT EXISTS project_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) REFERENCES projects(ref) ON DELETE CASCADE,
      task_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      payload JSONB DEFAULT '{}',
      error TEXT,
      retries INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
  `;

  // 使用显式配置而不是 URL，确保数据库名正确
  const sql = new SQL({
    hostname,
    port: parseInt(port, 10),
    database,
    username,
    password,
    max: 2,
  });

  try {
    await sql`SELECT 1`;
    console.log("Connected to database");

    // 检查当前数据库
    const [dbInfo] = await sql`SELECT current_database() as db, current_user as user`;
    console.log("Current database:", dbInfo?.db, "user:", dbInfo?.user);

    const result = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks')
    `;
    
    const tableCount = Number(result[0]?.count || 0);
    console.log(`Found ${tableCount} tables in database`);

    if (tableCount >= 3) {
      console.log("Tables already exist, skipping initialization");
      return;
    }

    console.log("Executing DDL statements...");
    
    // Bun SQL: unsafe() 可以直接执行多条语句
    await sql.unsafe(ddlQuery);
    console.log("DDL executed successfully.");

    const [verify] = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks')
    `;
    
    const finalCount = Number(verify?.count || 0);
    console.log(`Database initialized successfully! Tables verified: ${finalCount}/3`);
    
    if (finalCount < 3) {
      throw new Error(`Table creation verified but failed. Expected 3 tables, got ${finalCount}`);
    }
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  } finally {
    await sql.close();
  }
}
