import { SQL } from "bun";
import { config } from "../config";

export async function initDatabase() {
  console.log("Initializing database...");

  const adminUrl = config.databaseUrl.replace(/\/[^/]+$/, "/postgres");
  const adminSql = new SQL({
    url: adminUrl,
    max: 1,
    idleTimeout: 300,
    connectTimeout: 10000
  });

  try {
    const [exists] = await adminSql`
      SELECT 1 FROM pg_database WHERE datname = 'supacloud_meta'
    `;

    if (!exists) {
      console.log("Creating supacloud_meta database...");
      await adminSql`CREATE DATABASE supacloud_meta`.simple();
    }
  } catch (error: any) {
    if (error.message?.includes("Connection closed") || error.code === "ERR_POSTGRES_CONNECTION_CLOSED") {
      console.warn("[Init] Connection closed during DB creation check, retry once...");
    }
    console.warn("Warning: Could not verify/create supacloud_meta via admin connection.");
    console.warn("If the database was pre-created by install.sh, this is safe to ignore.");
  } finally {
    await adminSql.close();
  }

  const sql = new SQL({
    url: config.databaseUrl,
    max: 5,
    idleTimeout: 300,
    connectTimeout: 15000
  });

  try {
    await sql`SELECT 1`;
    console.log("Connected to supacloud_meta database");

    const result = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks')
    `;
    
    const tableCount = result[0]?.count || 0;
    console.log(`Found ${tableCount} tables in database`);

    if (tableCount >= 3) {
      console.log("Tables already exist, skipping initialization");
      return;
    }

    console.log("Creating organizations table...");
    await sql`CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`.simple();

    console.log("Creating projects table...");
    await sql`CREATE TABLE projects (
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
    )`.simple();

    console.log("Creating indexes...");
    await sql`CREATE INDEX idx_projects_ref ON projects(ref)`.simple();
    await sql`CREATE INDEX idx_projects_status ON projects(status)`.simple();

    console.log("Creating project_tasks table...");
    await sql`CREATE TABLE project_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) REFERENCES projects(ref) ON DELETE CASCADE,
      task_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      payload JSONB DEFAULT '{}',
      error TEXT,
      retries INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`.simple();

    await sql`CREATE INDEX idx_project_tasks_status ON project_tasks(status)`.simple();

    const [verify] = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks')
    `;
    
    console.log(`Database initialized successfully! Tables created: ${verify?.count || 0}`);
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  } finally {
    await sql.close();
  }
}
