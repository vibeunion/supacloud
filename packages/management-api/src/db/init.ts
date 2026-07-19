import { config } from "../config";
import { logger } from "../utils/logger";
import { SQL } from "bun";
import {
  generatePublishableApiKey,
  generateSecretApiKey,
  hashSecretApiKey,
} from "../utils/api-keys";
import {
  decryptSecretIfNeeded,
  encryptSecretIfNeeded,
} from "../utils/secret-crypto";

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function backfillOpaqueApiKeys(sql: SQL): Promise<number> {
  const rows = await sql`
    SELECT ref, publishable_key, secret_key_hash, secret_key_encrypted
    FROM projects
    WHERE publishable_key IS NULL
       OR secret_key_hash IS NULL
       OR secret_key_encrypted IS NULL
  `;

  let updated = 0;
  for (const row of rows as Array<Record<string, unknown>>) {
    const publishableKey = typeof row.publishable_key === "string" && row.publishable_key
      ? row.publishable_key
      : generatePublishableApiKey();
    let secretKey: string | null = null;
    if (typeof row.secret_key_encrypted === "string" && row.secret_key_encrypted) {
      try {
        secretKey = decryptSecretIfNeeded(row.secret_key_encrypted);
      } catch {
        secretKey = null;
      }
    }
    secretKey ||= generateSecretApiKey();

    await sql`
      UPDATE projects
      SET publishable_key = ${publishableKey},
          secret_key_hash = ${hashSecretApiKey(secretKey)},
          secret_key_encrypted = ${encryptSecretIfNeeded(secretKey)},
          updated_at = NOW()
      WHERE ref = ${String(row.ref)}
    `;
    updated += 1;
  }
  return updated;
}

export async function initDatabase() {
  logger.info("Initializing database...");
  logger.info(
    `DATABASE_URL: ${config.databaseUrl.replace(/:[^:@]+@/, ":****@")}`,
  );

  // Parse DATABASE_URL to get components
  const dbUrl = config.databaseUrl;
  const urlMatch = dbUrl.match(
    /postgresql?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/,
  );

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
      plan VARCHAR(50) NOT NULL DEFAULT 'free',
      owner_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organization_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email VARCHAR(320) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      user_id TEXT,
      invited_at TIMESTAMPTZ DEFAULT NOW(),
      joined_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_members_org_email
      ON organization_members (organization_id, lower(email));
    CREATE INDEX IF NOT EXISTS idx_organization_members_org
      ON organization_members (organization_id, created_at DESC);

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
      publishable_key TEXT,
      secret_key_hash VARCHAR(64),
      secret_key_encrypted TEXT,
      s3_bucket VARCHAR(63) NOT NULL,
      s3_access_key VARCHAR(100),
      s3_secret_key VARCHAR(100),
      region VARCHAR(50) DEFAULT 'local',
      status VARCHAR(20) DEFAULT 'creating',
      postgrest_desired VARCHAR(20),
      postgrest_actual VARCHAR(20),
      postgrest_health VARCHAR(20),
      postgrest_port INTEGER,
      postgrest_last_error TEXT,
      postgrest_updated_at TIMESTAMPTZ,
      postgrest_last_reconciled_at TIMESTAMPTZ,
      config JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_projects_ref ON projects(ref);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

    CREATE TABLE IF NOT EXISTS branch_replacement_journal (
      parent_ref TEXT PRIMARY KEY,
      branch_ref TEXT NOT NULL,
      parent_db TEXT NOT NULL,
      branch_db TEXT NOT NULL,
      temp_db TEXT NOT NULL,
      backup_db TEXT NOT NULL,
      phase TEXT NOT NULL,
      replacement_committed BOOLEAN NOT NULL DEFAULT FALSE,
      recovery_database TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) REFERENCES projects(ref) ON DELETE CASCADE,
      task_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      function_slug VARCHAR(255),
      function_version VARCHAR(128),
      payload JSONB DEFAULT '{}',
      result JSONB,
      error TEXT,
      retries INTEGER DEFAULT 0,
      attempt INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      next_run_at TIMESTAMPTZ DEFAULT NOW(),
      lease_until TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      timeout_sec INTEGER,
      idempotency_key VARCHAR(255),
      trace_id VARCHAR(255),
      cancel_requested_at TIMESTAMPTZ,
      cancellation_reason TEXT,
      correlation_id VARCHAR(255),
      business_task_id VARCHAR(255),
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);

    CREATE TABLE IF NOT EXISTS project_task_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER,
      error TEXT,
      response_status INTEGER,
      logs JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(task_id, attempt_no)
    );



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

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(50),
      actor TEXT NOT NULL DEFAULT 'unknown',
      action TEXT NOT NULL,
      method VARCHAR(16) NOT NULL,
      path TEXT NOT NULL,
      status INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      request_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created ON audit_logs(project_ref, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs(action, created_at DESC);

    CREATE TABLE IF NOT EXISTS studio_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(320) NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      ip_hash TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_studio_sessions_expires_at
      ON studio_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_studio_sessions_active
      ON studio_sessions(expires_at) WHERE revoked_at IS NULL;
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

  async function runMigrationStatement(statement: string, options?: { swallowError?: boolean; description?: string }) {
    try {
      await sql.unsafe(statement);
    } catch (error: any) {
      if (options?.swallowError) {
        logger.warn(`Skipped optional migration${options.description ? ` (${options.description})` : ""}: ${error?.message || String(error)}`);
        return;
      }
      throw error;
    }
  }

  try {
    await sql`SELECT 1`;
    logger.info("Connected to database");

    // Check current database
    const [dbInfo] =
      await sql`SELECT current_database() as db, current_user as user`;
    logger.info(`Current database: ${dbInfo?.db}, user: ${dbInfo?.user}`);

    const result = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'organization_members', 'projects', 'project_tasks', 'platform_settings', 'project_secrets', 'deployment_history', 'system_tus_uploads', 'system_tus_chunks', 'system_signed_uploads', 'audit_logs', 'studio_sessions')
    `;

    const tableCount = Number(result[0]?.count || 0);
    logger.info(`Found ${tableCount} tables in database`);

    if (tableCount < 12) {
      logger.info("Executing DDL statements...");
      await sql.unsafe(ddlQuery);
      logger.info("DDL executed successfully.");
    } else {
      logger.info("Tables already exist, skipping table creation.");
    }

    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
          CREATE ROLE supabase_realtime_admin LOGIN NOINHERIT CREATEROLE REPLICATION PASSWORD ${sqlStringLiteral(password)};
        ELSE
          ALTER ROLE supabase_realtime_admin LOGIN NOINHERIT CREATEROLE REPLICATION PASSWORD ${sqlStringLiteral(password)};
        END IF;
      END
      $$;
    `);

    // Always apply migrations to ensure schema is up-to-date
    const migrationStatements: Array<{ statement: string; description: string; swallowError?: boolean }> = [
      { statement: "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan VARCHAR(50) NOT NULL DEFAULT 'free'", description: "organizations.plan" },
      { statement: "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_id TEXT", description: "organizations.owner_id" },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS organization_members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            email VARCHAR(320) NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'member',
            user_id TEXT,
            invited_at TIMESTAMPTZ DEFAULT NOW(),
            joined_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `,
        description: "organization_members table",
      },
      {
        statement: `
          CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_members_org_email
          ON organization_members (organization_id, lower(email))
        `,
        description: "idx_organization_members_org_email",
      },
      {
        statement: `
          CREATE INDEX IF NOT EXISTS idx_organization_members_org
          ON organization_members (organization_id, created_at DESC)
        `,
        description: "idx_organization_members_org",
      },
      { statement: 'ALTER TABLE system_tus_uploads ADD COLUMN IF NOT EXISTS auth_token TEXT', description: "system_tus_uploads.auth_token" },
      { statement: 'ALTER TABLE system_signed_uploads ADD COLUMN IF NOT EXISTS auth_token TEXT', description: "system_signed_uploads.auth_token" },
      { statement: 'ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()', description: "project_secrets.updated_at" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS db_password_encrypted TEXT', description: "projects.db_password_encrypted" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS jwt_secret_encrypted TEXT', description: "projects.jwt_secret_encrypted" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_role_key_encrypted TEXT', description: "projects.service_role_key_encrypted" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS publishable_key TEXT', description: "projects.publishable_key" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_key_hash VARCHAR(64)', description: "projects.secret_key_hash" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_key_encrypted TEXT', description: "projects.secret_key_encrypted" },
      { statement: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_publishable_key ON projects(publishable_key) WHERE publishable_key IS NOT NULL', description: "idx_projects_publishable_key" },
      { statement: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_secret_key_hash ON projects(secret_key_hash) WHERE secret_key_hash IS NOT NULL', description: "idx_projects_secret_key_hash" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS s3_secret_key_encrypted TEXT', description: "projects.s3_secret_key_encrypted" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_desired VARCHAR(20)', description: "projects.postgrest_desired" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_actual VARCHAR(20)', description: "projects.postgrest_actual" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_health VARCHAR(20)', description: "projects.postgrest_health" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_port INTEGER', description: "projects.postgrest_port" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_last_error TEXT', description: "projects.postgrest_last_error" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_updated_at TIMESTAMPTZ', description: "projects.postgrest_updated_at" },
      { statement: 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS postgrest_last_reconciled_at TIMESTAMPTZ', description: "projects.postgrest_last_reconciled_at" },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS branch_replacement_journal (
            parent_ref TEXT PRIMARY KEY,
            branch_ref TEXT NOT NULL,
            parent_db TEXT NOT NULL,
            branch_db TEXT NOT NULL,
            temp_db TEXT NOT NULL,
            backup_db TEXT NOT NULL,
            phase TEXT NOT NULL,
            replacement_committed BOOLEAN NOT NULL DEFAULT FALSE,
            recovery_database TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        description: "branch_replacement_journal table",
      },
      { statement: 'ALTER TABLE branch_replacement_journal ADD COLUMN IF NOT EXISTS recovery_database TEXT', description: "branch_replacement_journal.recovery_database" },
      { statement: 'ALTER TABLE branch_replacement_journal ADD COLUMN IF NOT EXISTS replacement_committed BOOLEAN NOT NULL DEFAULT FALSE', description: "branch_replacement_journal.replacement_committed" },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS audit_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_ref VARCHAR(50),
            actor TEXT NOT NULL DEFAULT 'unknown',
            action TEXT NOT NULL,
            method VARCHAR(16) NOT NULL,
            path TEXT NOT NULL,
            status INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            request_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `,
        description: "audit_logs table",
      },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created ON audit_logs(project_ref, created_at DESC)', description: "idx_audit_logs_project_created" },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs(action, created_at DESC)', description: "idx_audit_logs_action_created" },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS studio_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            username VARCHAR(320) NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            ip_hash TEXT NOT NULL,
            user_agent TEXT NOT NULL DEFAULT '',
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        description: "studio_sessions table",
      },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_studio_sessions_expires_at ON studio_sessions(expires_at)', description: "idx_studio_sessions_expires_at" },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_studio_sessions_active ON studio_sessions(expires_at) WHERE revoked_at IS NULL', description: "idx_studio_sessions_active" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS function_slug VARCHAR(255)', description: "project_tasks.function_slug" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS function_version VARCHAR(128)', description: "project_tasks.function_version" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT \'{}\'::jsonb', description: "project_tasks.payload" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS result JSONB', description: "project_tasks.result" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 0', description: "project_tasks.attempt" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 3', description: "project_tasks.max_attempts" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ DEFAULT NOW()', description: "project_tasks.next_run_at" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ', description: "project_tasks.lease_until" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ', description: "project_tasks.started_at" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ', description: "project_tasks.completed_at" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS timeout_sec INTEGER', description: "project_tasks.timeout_sec" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)', description: "project_tasks.idempotency_key" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS trace_id VARCHAR(255)', description: "project_tasks.trace_id" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ', description: "project_tasks.cancel_requested_at" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS cancellation_reason TEXT', description: "project_tasks.cancellation_reason" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)', description: "project_tasks.correlation_id" },
      { statement: 'ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS business_task_id VARCHAR(255)', description: "project_tasks.business_task_id" },
      { statement: "ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb", description: "project_tasks.metadata" },
      { statement: 'ALTER TABLE project_tasks ALTER COLUMN next_run_at SET DEFAULT NOW()', description: "project_tasks.next_run_at default", swallowError: true },
      { statement: 'UPDATE project_tasks SET next_run_at = COALESCE(next_run_at, created_at, NOW())', description: "project_tasks.next_run_at backfill" },
      { statement: 'UPDATE project_tasks SET max_attempts = COALESCE(max_attempts, 3)', description: "project_tasks.max_attempts backfill" },
      { statement: 'UPDATE project_tasks SET attempt = COALESCE(attempt, retries, 0)', description: "project_tasks.attempt backfill" },
      { statement: "UPDATE project_tasks SET payload = COALESCE(payload, '{}'::jsonb)", description: "project_tasks.payload backfill" },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status ON project_tasks(project_ref, status)', description: "idx_project_tasks_project_status" },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_project_tasks_project_created_desc ON project_tasks(project_ref, created_at DESC)', description: "idx_project_tasks_project_created_desc" },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_project_tasks_next_run ON project_tasks(next_run_at)', description: "idx_project_tasks_next_run" },
      {
        statement: `
          CREATE INDEX IF NOT EXISTS idx_project_tasks_queue_ready
          ON project_tasks(project_ref, task_type, status, next_run_at, created_at)
          WHERE status IN ('pending', 'retry_scheduled') AND cancel_requested_at IS NULL
        `,
        description: "idx_project_tasks_queue_ready",
      },
      {
        statement: `
          CREATE INDEX IF NOT EXISTS idx_project_tasks_active_lease
          ON project_tasks(project_ref, task_type, status, lease_until)
          WHERE status IN ('leased', 'running')
        `,
        description: "idx_project_tasks_active_lease",
      },
      {
        statement: `
          CREATE INDEX IF NOT EXISTS idx_project_tasks_project_updated_status
          ON project_tasks(project_ref, updated_at DESC, status)
        `,
        description: "idx_project_tasks_project_updated_status",
      },
      {
        statement: `
          CREATE INDEX IF NOT EXISTS idx_project_tasks_project_function_created
          ON project_tasks(project_ref, function_slug, created_at DESC)
          WHERE function_slug IS NOT NULL
        `,
        description: "idx_project_tasks_project_function_created",
      },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS diagnostic_runs (
            id TEXT PRIMARY KEY,
            scope VARCHAR(20) NOT NULL,
            project_ref VARCHAR(20),
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            summary JSONB
          )
        `,
        description: "diagnostic_runs table",
      },
      {
        statement: `CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_scope ON diagnostic_runs(scope, started_at DESC)`,
        description: "idx_diagnostic_runs_scope",
      },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS diagnostic_results (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES diagnostic_runs(id) ON DELETE CASCADE,
            check_id TEXT NOT NULL,
            status VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            detail TEXT,
            repair_preview TEXT,
            repair_command TEXT,
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        description: "diagnostic_results table",
      },
      {
        statement: `CREATE INDEX IF NOT EXISTS idx_diagnostic_results_run ON diagnostic_results(run_id)`,
        description: "idx_diagnostic_results_run",
      },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS diagnostic_baselines (
            check_id TEXT NOT NULL,
            scope VARCHAR(20) NOT NULL,
            project_ref VARCHAR(20) NOT NULL DEFAULT '',
            expected_status VARCHAR(20),
            expected_hash TEXT,
            snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (check_id, scope, project_ref)
          )
        `,
        description: "diagnostic_baselines table",
      },
      {
        statement: "UPDATE diagnostic_baselines SET project_ref = '' WHERE project_ref IS NULL",
        description: "diagnostic_baselines.project_ref backfill",
        swallowError: true,
      },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS diagnostic_repair_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            result_id TEXT NOT NULL,
            check_id TEXT NOT NULL,
            success BOOLEAN NOT NULL,
            message TEXT NOT NULL,
            applied_command TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        description: "diagnostic_repair_logs table",
      },
      { statement: 'CREATE INDEX IF NOT EXISTS idx_project_tasks_cancel_requested ON project_tasks(cancel_requested_at) WHERE cancel_requested_at IS NOT NULL', description: "idx_project_tasks_cancel_requested" },
      {
        statement: `
          CREATE UNIQUE INDEX IF NOT EXISTS idx_project_tasks_project_idempotency
          ON project_tasks(project_ref, idempotency_key)
          WHERE idempotency_key IS NOT NULL
        `,
        description: "idx_project_tasks_project_idempotency",
      },
      {
        statement: `
          CREATE TABLE IF NOT EXISTS project_task_attempts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
            project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
            attempt_no INTEGER NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            duration_ms INTEGER,
            error TEXT,
            response_status INTEGER,
            logs JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(task_id, attempt_no)
          )
        `,
        description: "project_task_attempts table",
      },
      { statement: "ALTER TABLE project_task_attempts ADD COLUMN IF NOT EXISTS logs JSONB DEFAULT '[]'::jsonb", description: "project_task_attempts.logs" },
      { statement: "CREATE INDEX IF NOT EXISTS idx_project_task_attempts_task ON project_task_attempts(task_id, attempt_no DESC)", description: "idx_project_task_attempts_task" },
      { statement: "CREATE INDEX IF NOT EXISTS idx_project_task_attempts_project ON project_task_attempts(project_ref, created_at DESC)", description: "idx_project_task_attempts_project" },
      {
        statement: `
          ALTER TABLE project_tasks
            DROP CONSTRAINT IF EXISTS project_tasks_project_ref_fkey,
            ADD CONSTRAINT project_tasks_project_ref_fkey
              FOREIGN KEY (project_ref) REFERENCES projects(ref) ON DELETE CASCADE
        `,
        description: "project_tasks FK cascade",
        swallowError: true,
      },
      {
        statement: `DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'deployment_history' AND column_name = 'project_ref'
            ) THEN
              DROP TABLE IF EXISTS deployment_history CASCADE;
              CREATE TABLE deployment_history (
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
            END IF;
          END
        $$;`,
        description: "deployment_history schema migration (legacy project_ref -> new app/tenant schema)",
      },
    ];

    for (const migration of migrationStatements) {
      await runMigrationStatement(migration.statement, {
        swallowError: migration.swallowError,
        description: migration.description,
      });
    }
    logger.info("Schema migrations applied.");

    const opaqueKeyBackfillCount = await backfillOpaqueApiKeys(sql);
    if (opaqueKeyBackfillCount > 0) {
      logger.info(`Opaque API keys backfilled for ${opaqueKeyBackfillCount} project(s).`);
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
            'task_type', NEW.task_type,
            'next_run_at', NEW.next_run_at
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
      WHERE table_schema = 'public' AND table_name IN ('organizations', 'organization_members', 'projects', 'project_tasks', 'platform_settings', 'project_secrets', 'deployment_history', 'system_tus_uploads', 'system_tus_chunks', 'system_signed_uploads', 'audit_logs', 'studio_sessions')
    `;

    const finalPublicCount = Number(verify?.count || 0);
    logger.info(
      `Database initialized successfully! Public tables verified: ${finalPublicCount}/12`,
    );

    // In CI mode where tests rewrite db_name to 'postgres', we must create Storage relations
    let storageTableCount = 0;
    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.TEST_FIXED_JWT_SECRET) {
      logger.info(
        "Initializing Storage schemas natively for E2E CI routing...",
      );
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_bucketid_name ON storage.objects (bucket_id, name);
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
        GRANT ALL PRIVILEGES ON SCHEMA storage TO postgres, supabase_admin;
        GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO postgres, supabase_admin, anon, authenticated, service_role;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage TO postgres, supabase_admin, anon, authenticated, service_role;
        GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA storage TO postgres, supabase_admin, anon, authenticated, service_role;
      `;
      try {
        await sql.unsafe(storageDDL);
        const [storageVerify] = await sql`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_schema = 'storage'
            AND table_name IN ('buckets', 'objects', 's3_multipart_uploads', 's3_multipart_uploads_parts')
        `;
        storageTableCount = Number(storageVerify?.count || 0);
        logger.info("Storage schema injected for CI.");
      } catch (e: any) {
        logger.error("Failed to inject Storage schema: " + e.message);
      }
    }

    if (finalPublicCount < 12) {
      throw new Error(
        `Table creation verified but failed. Expected 12 public tables, got ${finalPublicCount}`,
      );
    }

    if ((process.env.CI || process.env.GITHUB_ACTIONS || process.env.TEST_FIXED_JWT_SECRET) && storageTableCount < 4) {
      throw new Error(
        `Storage schema injection verified but failed. Expected 4 storage tables, got ${storageTableCount}`,
      );
    }
  } catch (error: unknown) {
    logger.error("Failed to initialize database:", {
      error: error instanceof Error ? error.message : String(error),
    });
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
