import { SQL } from "bun";
import { config } from "../config";

export async function initDatabase() {
  console.log("Initializing database...");

  // 先连接到默认 postgres 数据库创建 supacloud_meta
  const adminUrl = config.databaseUrl.replace(/\/[^/]+$/, "/postgres");
  const adminSql = new SQL({ url: adminUrl });

  try {
    // 检查数据库是否存在
    const [exists] = await adminSql`
      SELECT 1 FROM pg_database WHERE datname = 'supacloud_meta'
    `;

    if (!exists) {
      console.log("Creating supacloud_meta database...");
      await adminSql`CREATE DATABASE supacloud_meta`.simple();
    }
  } catch (error) {
    // 连接 postgres 库可能因 pg_hba.conf TCP 认证失败
    // install.sh 已在调用 db:init 前通过 su postgres psql 预创建了数据库
    // 若仍失败，请手动执行：
    //   su - postgres -c "psql -c 'CREATE DATABASE supacloud_meta'"
    //   ALTER USER postgres PASSWORD '<your_password>';
    console.warn("Warning: Could not verify/create supacloud_meta via admin connection.");
    console.warn("If the database was pre-created by install.sh, this is safe to ignore.");
    console.warn("To fix manually: su - postgres -c \"psql -c 'CREATE DATABASE supacloud_meta'\"");
  } finally {
    await adminSql.close();
  }

  // 连接到 supacloud_meta 数据库创建表
  const sql = new SQL({ url: config.databaseUrl });

  try {
    // 创建 organizations 表
    await sql`
      CREATE TABLE IF NOT EXISTS organizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // 创建 projects 表
    await sql`
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
      )
    `;

    // 创建索引
    await sql`
      CREATE INDEX IF NOT EXISTS idx_projects_ref ON projects(ref)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)
    `;

    // 创建 project_tasks 表
    await sql`
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
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status)
    `;

    console.log("Database initialized successfully!");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  } finally {
    await sql.close();
  }
}

