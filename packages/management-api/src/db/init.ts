import { config } from "../config";
import { logger } from "../utils/logger";
import { SQL } from "bun";

export async function initDatabase() {
  logger.info("Initializing database...");
  logger.info(`DATABASE_URL: ${config.databaseUrl.replace(/:[^:@]+@/, ":****@")}`);

  // Parse DATABASE_URL to get components
  const dbUrl = config.databaseUrl;
  const urlMatch = dbUrl.match(/postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  
  if (!urlMatch) {
    throw new Error("Invalid DATABASE_URL format");
  }
  
  const [, username, password, hostname, port, database] = urlMatch;
  logger.info(`Connecting to database: ${database} on ${hostname}:${port}`);

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

    CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      description TEXT,
      is_secret BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  // Use explicit config instead of URL to ensure correct database name
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
    logger.info("Connected to database");

    // Check current database
    const [dbInfo] = await sql`SELECT current_database() as db, current_user as user`;
    logger.info(`Current database: ${dbInfo?.db}, user: ${dbInfo?.user}`);

    const result = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks', 'platform_settings')
    `;
    
    const tableCount = Number(result[0]?.count || 0);
    logger.info(`Found ${tableCount} tables in database`);

    if (tableCount < 4) {
      logger.info("Executing DDL statements...");
      await sql.unsafe(ddlQuery);
      logger.info("DDL executed successfully.");
    } else {
      logger.info("Tables already exist, skipping table creation.");
    }

    // Always apply trigger (idempotent: CREATE OR REPLACE + DROP IF EXISTS)
    const notifyTriggerDDL = `
      CREATE OR REPLACE FUNCTION notify_task_change() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify(
          'task_' || NEW.status,
          json_build_object(
            'id', NEW.id,
            'project_ref', NEW.project_ref,
            'task_type', NEW.task_type
          )::text
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_task_notify ON project_tasks;
      CREATE TRIGGER trg_task_notify
        AFTER INSERT OR UPDATE ON project_tasks
        FOR EACH ROW EXECUTE FUNCTION notify_task_change();
    `;
    await sql.unsafe(notifyTriggerDDL);
    logger.info("LISTEN/NOTIFY trigger applied.");

    const [verify] = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks', 'platform_settings')
    `;
    
    const finalCount = Number(verify?.count || 0);
    logger.info(`Database initialized successfully! Tables verified: ${finalCount}/4`);
    
    if (finalCount < 4) {
      throw new Error(`Table creation verified but failed. Expected 4 tables, got ${finalCount}`);
    }
  } catch (error: unknown) {
    logger.error("Failed to initialize database:", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  initDatabase().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
