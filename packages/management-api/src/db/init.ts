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

    CREATE TABLE IF NOT EXISTS project_secrets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) REFERENCES projects(ref) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_ref, name)
    );

    CREATE INDEX IF NOT EXISTS idx_project_secrets_ref ON project_secrets(project_ref);

    CREATE TABLE IF NOT EXISTS deployment_history (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      tenant TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      triggered_by TEXT NOT NULL DEFAULT 'api',
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_tus_uploads (
      id VARCHAR(255) PRIMARY KEY,
      ref VARCHAR(50) NOT NULL,
      bucket VARCHAR(63) NOT NULL,
      object_name TEXT NOT NULL,
      content_type VARCHAR(100) NOT NULL,
      total_size BIGINT NOT NULL,
      offset_size BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_tus_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id VARCHAR(255) REFERENCES system_tus_uploads(id) ON DELETE CASCADE,
      chunk_data BYTEA NOT NULL,
      chunk_offset BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS system_signed_uploads (
      token TEXT PRIMARY KEY,
      ref VARCHAR(50) NOT NULL,
      bucket VARCHAR(63) NOT NULL,
      object_name TEXT NOT NULL,
      upsert BOOLEAN DEFAULT false,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_config (
      project_ref VARCHAR(20) PRIMARY KEY REFERENCES projects(ref) ON DELETE CASCADE,
      postgrest_port INTEGER,
      gotrue_port INTEGER,
      realtime_port INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
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
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks', 'platform_settings', 'project_secrets', 'deployment_history', 'system_tus_uploads', 'system_tus_chunks', 'system_signed_uploads', 'project_config')
    `;
    
    const tableCount = Number(result[0]?.count || 0);
    logger.info(`Found ${tableCount} tables in database`);

    if (tableCount < 10) {
      logger.info("Executing DDL statements...");
      await sql.unsafe(ddlQuery);
      logger.info("DDL executed successfully.");
    } else {
      logger.info("Tables already exist, skipping table creation.");
    }

    // Always apply migrations to ensure schema is up-to-date
    try {
      await sql`ALTER TABLE system_tus_uploads ADD COLUMN IF NOT EXISTS auth_token TEXT`;
      await sql`ALTER TABLE system_signed_uploads ADD COLUMN IF NOT EXISTS auth_token TEXT`;
      logger.info("Schema migrations applied.");
    } catch (e: any) {
      logger.error("Failed to apply migrations: " + e.message);
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
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'projects', 'project_tasks', 'platform_settings', 'project_secrets', 'deployment_history', 'system_tus_uploads', 'system_tus_chunks', 'system_signed_uploads', 'project_config')
    `;
    
    const finalCount = Number(verify?.count || 0);
    logger.info(`Database initialized successfully! Tables verified: ${finalCount}/10`);
    
    // In CI mode where tests rewrite db_name to 'postgres', we must create Storage relations
    if (process.env.CI || process.env.TEST_FIXED_JWT_SECRET) {
      logger.info("Initializing Storage schemas natively for E2E CI routing...");
      const storageDDL = `
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
            id text not null primary key,
            name text not null,
            owner uuid,
            created_at timestamptz default now(),
            updated_at timestamptz default now(),
            public boolean default false,
            avif_autodetection boolean default false,
            file_size_limit bigint,
            allowed_mime_types text[]
        );
        CREATE TABLE IF NOT EXISTS storage.objects (
            id uuid not null primary key default gen_random_uuid(),
            bucket_id text references storage.buckets,
            name text,
            owner uuid,
            created_at timestamptz default now(),
            updated_at timestamptz default now(),
            last_accessed_at timestamptz default now(),
            metadata jsonb,
            path_tokens text[] generated always as (string_to_array(name, '/')) stored,
            version text default gen_random_uuid()
        );
        CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads (
            id text not null primary key,
            in_progress_size bigint not null default 0,
            upload_signature text not null,
            bucket_id text not null references storage.buckets(id),
            key text not null,
            version text not null,
            owner_id uuid,
            created_at timestamptz not null default now()
        );
        CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads_parts (
            id uuid not null primary key default gen_random_uuid(),
            upload_id text not null references storage.s3_multipart_uploads(id) on delete cascade,
            part_number integer not null,
            size bigint not null default 0,
            etag text not null,
            owner_id uuid,
            created_at timestamptz not null default now()
        );
      `;
      try {
        await sql.unsafe(storageDDL);
        logger.info("Storage schema injected for CI.");
      } catch (e: any) {
        logger.error("Failed to inject Storage schema: " + e.message);
      }
    }
    if (finalCount < 10) {
      throw new Error(`Table creation verified but failed. Expected 10 tables, got ${finalCount}`);
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
