import { config } from "../config";
import { logger } from "../utils/logger";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";
import { shellService } from "./shell.service";
import { SQL } from "bun";
import {
  sql as adminSql,
  getProjectDb,
  resolveDbName,
  resolveRoleName,
  resolveAuthenticatorName,
  generateDbName,
} from "../db";
import { $ } from "bun";
import * as path from "node:path";
import { assertValidIdentifier, assertValidDbName } from "../utils/validation";
import { ensureMigrationLedgerMetadata } from "./migration-ledger";
import { prepareProjectMigrationRole } from "./project-migration-role";

/** Escape a string value for use inside PostgreSQL dollar-quoted strings */
function pgEscapePassword(password: string): string {
  // Use dollar-quoting with unique tag to safely embed passwords
  // The tag includes a hash and a random segment to avoid collision with password content
  const randomSegment = crypto.randomUUID().slice(0, 8);
  const tag = `pw${Bun.hash(password).toString(36).slice(0, 4)}${randomSegment}`;
  return `$${tag}$${password}$${tag}$`;
}

export function renderAuthSchemaOwnershipSql(authOwner = "supabase_auth_admin"): string {
  assertValidIdentifier("authOwner", authOwner);
  const owner = `"${authOwner}"`;
  return `
ALTER SCHEMA auth OWNER TO ${owner};

DO $$
DECLARE
  auth_object RECORD;
  alter_kind TEXT;
BEGIN
  FOR auth_object IN
    SELECT c.relkind, n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND NOT (
        c.relkind = 'S'
        AND EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'a'
        )
      )
  LOOP
    alter_kind := CASE auth_object.relkind
      WHEN 'S' THEN 'SEQUENCE'
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'f' THEN 'FOREIGN TABLE'
      ELSE 'TABLE'
    END;
    EXECUTE format('ALTER %s %I.%I OWNER TO ${owner}', alter_kind, auth_object.nspname, auth_object.relname);
  END LOOP;
END $$;

DO $$
DECLARE
  auth_function RECORD;
BEGIN
  FOR auth_function IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO ${owner}', auth_function.nspname, auth_function.proname, auth_function.args);
  END LOOP;
END $$;

DO $$
DECLARE
  auth_type RECORD;
BEGIN
  FOR auth_type IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'auth'
      AND t.typtype IN ('d', 'e')
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO ${owner}', auth_type.nspname, auth_type.typname);
  END LOOP;
END $$;
`;
}

export function renderPgStatStatementsCompatibilitySql(): string {
  return `
CREATE SCHEMA IF NOT EXISTS extensions;

DO $compat$
DECLARE
  source_schema TEXT;
BEGIN
  SELECT n.nspname
  INTO source_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_stat_statements';

  IF source_schema IS NOT NULL AND source_schema <> 'extensions' THEN
    IF to_regclass(format('%I.pg_stat_statements', source_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE OR REPLACE VIEW extensions.pg_stat_statements AS SELECT * FROM %I.pg_stat_statements',
        source_schema
      );
    END IF;

    IF to_regclass(format('%I.pg_stat_statements_info', source_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE OR REPLACE VIEW extensions.pg_stat_statements_info AS SELECT * FROM %I.pg_stat_statements_info',
        source_schema
      );
    END IF;

    IF to_regprocedure(format('%I.pg_stat_statements(boolean)', source_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION extensions.pg_stat_statements(showtext boolean) RETURNS SETOF %I.pg_stat_statements LANGUAGE sql STABLE AS $function$ SELECT * FROM %I.pg_stat_statements(showtext); $function$',
        source_schema,
        source_schema
      );
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
      IF to_regclass('extensions.pg_stat_statements') IS NOT NULL THEN
        ALTER VIEW extensions.pg_stat_statements OWNER TO supabase_admin;
      END IF;
      IF to_regclass('extensions.pg_stat_statements_info') IS NOT NULL THEN
        ALTER VIEW extensions.pg_stat_statements_info OWNER TO supabase_admin;
      END IF;
      IF to_regprocedure('extensions.pg_stat_statements(boolean)') IS NOT NULL THEN
        ALTER FUNCTION extensions.pg_stat_statements(boolean) OWNER TO supabase_admin;
      END IF;
    END IF;
  END IF;
END
$compat$;
`;
}

export class DatabaseService {
  private readonly PG_HOST = config.pgHost;
  private readonly PG_PORT = config.pgPort;
  private readonly PG_USER = config.pgUser;
  private readonly PG_PASSWORD = config.pgPassword;
  private readonly PG_DATABASE = config.pgDatabase;

  generatePassword(length = 32): string {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, length);
  }

  private async loadSupabaseSchema(): Promise<string> {
    const candidates = [
      process.env.SUPABASE_SCHEMA_PATH,
      path.join(import.meta.dir, "../db/schemas/supabase.sql"),
      path.join(process.cwd(), "src/db/schemas/supabase.sql"),
      path.join(process.cwd(), "db/schemas/supabase.sql"),
      path.join(process.cwd(), "packages/management-api/src/db/schemas/supabase.sql"),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return await file.text();
      }
    }

    throw new Error(
      `Unable to locate supabase.sql. Looked in: ${candidates.join(", ")}`,
    );
  }

  // Reuse global admin connection pool from db/index.ts
  private get adminDb(): SQL {
    return adminSql;
  }

  // Tenant project DB connection - reuse cached pool from db/index.ts
  private getTenantDb(dbName: string): SQL {
    return getProjectDb(dbName);
  }

  // Unified execution wrap for Admin DB (no longer creates/closes connections)
  private async withAdminDb<T>(operation: (db: SQL) => Promise<T>): Promise<T> {
    return await operation(this.adminDb);
  }

  // Unified execution wrap for Tenant DB (uses cached pool)
  private async withTenantDb<T>(
    dbName: string,
    operation: (db: SQL) => Promise<T>,
  ): Promise<T> {
    return await operation(this.getTenantDb(dbName));
  }

  // Disk space pre-check: prevent WAL disk full which causes cluster panic
  private async checkDiskSpace(): Promise<void> {
    const minGb = config.minDiskGb;
    const minKb = minGb * 1024 * 1024;

    let targetDir = config.pgDataDir;

    const testDir = await $`test -d ${targetDir}`.nothrow().quiet();
    if (testDir.exitCode !== 0) {
      targetDir = "/";
    }

    try {
      const dfOut = await $`df -k ${targetDir}`.nothrow().quiet();
      if (dfOut.exitCode === 0) {
        const lines = dfOut.text().trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].trim().split(/\s+/);
          const availKb = parseInt(parts[3]);

          if (availKb < minKb) {
            throw new Error(
              `Insufficient disk space on ${targetDir}. Available: ${Math.floor(availKb / 1024)}MB. Required minimum: ${minGb}GB.`,
            );
          }
        }
      }
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error instanceof Error ? error.message : String(error)).includes(
          "Insufficient disk space",
        )
      ) {
        throw error;
      }
    }
  }

  // Create tenant database
  async checkDatabaseExists(projectRef: string): Promise<boolean> {
    const dbName = generateDbName(projectRef);
    try {
      return await this.withAdminDb(async (adminDb) => {
        const [row] = await adminDb`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
        return !!row;
      });
    } catch {
      return false;
    }
  }

  async createDatabase(
    projectRef: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const dbName = generateDbName(projectRef);
    const dbUser = resolveRoleName(projectRef);
    let databaseCreated = false;

    try {
      // Verify identifiers for safety to prevent SQL injection in DDL
      assertValidDbName("dbName", dbName);
      assertValidIdentifier("dbUser", dbUser);

      await this.checkDiskSpace();

      await this.withAdminDb(async (adminDb) => {
        // Check if database already exists
        const [dbExists] = await adminDb`
          SELECT 1 FROM pg_database WHERE datname = ${dbName}
        `;

        await this.reconcileProjectRole(adminDb, dbUser, password);

        if (!dbExists) {
          // Create database - use double quotes to support identifiers with hyphens
          await adminDb.unsafe(
            `CREATE DATABASE "${dbName}" OWNER ${this.PG_USER}`,
          );
          databaseCreated = true;
        }

        // Set kernel-level configs for resource exhaustion prevention
        await adminDb.unsafe(`
          ALTER ROLE "${dbUser}" SET statement_timeout = '30s';
          ALTER ROLE "${dbUser}" SET idle_in_transaction_session_timeout = '1min';
          ALTER ROLE "${dbUser}" SET work_mem = '4MB';
        `);

        await adminDb.unsafe(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
        await adminDb.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO "${dbUser}"`);
        await adminDb.unsafe(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO ${this.PG_USER}`);
      });

      if (databaseCreated) {
        await this.applySupabaseSchema(dbName, projectRef, password);
      } else {
        await this.reconcileAuthenticatorRole(dbName, projectRef, password);
      }
      await this.prepareMigrationRole(dbName, dbUser);

      await this.withAdminDb(async (adminDb) => {
        const authenticatorRole = resolveAuthenticatorName(projectRef);
        assertValidIdentifier("authenticatorRole", authenticatorRole);
        await adminDb.unsafe(`
          GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO "${authenticatorRole}";
          GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO supabase_auth_admin;
          GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO supabase_admin;
        `);
      });

      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async reconcileProjectRole(
    adminDb: SQL,
    dbUser: string,
    password: string,
  ): Promise<void> {
    const escapedPassword = pgEscapePassword(password);
    await adminDb.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${dbUser}') THEN
          ALTER ROLE "${dbUser}" LOGIN CONNECTION LIMIT 20 PASSWORD ${escapedPassword};
        ELSE
          CREATE ROLE "${dbUser}" LOGIN CONNECTION LIMIT 20 PASSWORD ${escapedPassword};
        END IF;
      END
      $$;
    `);
  }

  private async reconcileAuthenticatorRole(
    dbName: string,
    projectRef: string,
    password: string,
  ): Promise<void> {
    const authenticatorRole = resolveAuthenticatorName(projectRef);
    assertValidIdentifier("authenticatorRole", authenticatorRole);
    const escapedPassword = pgEscapePassword(password);

    await this.withAdminDb(async (adminDb) => {
      await adminDb.unsafe(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${authenticatorRole}') THEN
            ALTER ROLE "${authenticatorRole}" CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${escapedPassword};
          ELSE
            CREATE ROLE "${authenticatorRole}" CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${escapedPassword};
          END IF;
        END
        $$;

        GRANT anon, authenticated, service_role TO "${authenticatorRole}";
        ALTER ROLE "${authenticatorRole}" SET statement_timeout = '15s';
        ALTER ROLE "${authenticatorRole}" SET idle_in_transaction_session_timeout = '30s';
        ALTER ROLE "${authenticatorRole}" SET work_mem = '4MB';
        GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO "${authenticatorRole}";
      `);
    });
  }

  private async prepareMigrationRole(dbName: string, dbUser: string): Promise<void> {
    const tenantDb = getProjectDb(dbName);
    await ensureMigrationLedgerMetadata(tenantDb);
    await prepareProjectMigrationRole(tenantDb, dbName, dbUser);
  }

  // Apply Supabase Schema
  private async applySupabaseSchema(
    dbName: string,
    projectRef: string,
    password: string,
  ): Promise<void> {
    const dbUser = resolveRoleName(projectRef);
    await this.withTenantDb(dbName, async (tenantDb) => {
      // Create core extensions unconditionally (PG native)
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // Graciously attempt to create Supabase-specific extensions
      // Core Supabase extensions
      // pg_graphql intentionally stays opt-in through ExtensionService. Enabling
      // it by default exposes an additional API surface that Supabase disabled
      // for new projects in 2026.
      const coreExts = ["pg_net", "pgsodium", "vault"];
      // Ecosystem extensions (P1-1 ~ P1-4): available if host PostgreSQL has the packages installed
      const ecosystemExts = [
        "pg_cron",
        "vector",
        "postgis",
        "pg_stat_statements",
        "pgaudit",
      ];
      for (const ext of [...coreExts, ...ecosystemExts]) {
        try {
          // pg_cron must be created in postgres database first, but we create IF NOT EXISTS in tenant db as well
          await tenantDb.unsafe(
            `CREATE EXTENSION IF NOT EXISTS "${ext}" CASCADE`,
          );
        } catch (e) {
          logger.warn(
            `[DatabaseService] Extension ${ext} not available on this Postgres cluster. Skipping.`,
          );
        }
      }

      // Create API roles - use double quotes to support hyphens
      const authenticatorRole = resolveAuthenticatorName(projectRef);
      const anonRole = `anon`;
      const authenticatedRole = `authenticated`;
      const serviceRole = `service_role`;

      // Safe check identifiers
      assertValidIdentifier("authenticatorRole", authenticatorRole);

      // PostgreSQL doesn't support CREATE ROLE IF NOT EXISTS, use DO block
      await tenantDb.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${anonRole}') THEN
            CREATE ROLE ${anonRole} NOLOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${authenticatedRole}') THEN
            CREATE ROLE ${authenticatedRole} NOLOGIN NOINHERIT;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${serviceRole}') THEN
            CREATE ROLE ${serviceRole} NOLOGIN NOINHERIT BYPASSRLS;
          END IF;
        END
        $$;
      `);

      await tenantDb.unsafe(`
        CREATE ROLE "${authenticatorRole}" CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD ${pgEscapePassword(password)};
        GRANT ${anonRole}, ${authenticatedRole}, ${serviceRole} TO "${authenticatorRole}";

        -- Set shorter timeout and same memory limits for API Role to prevent cascade failures
        ALTER ROLE "${authenticatorRole}" SET statement_timeout = '15s';
        ALTER ROLE "${authenticatorRole}" SET idle_in_transaction_session_timeout = '30s';
        ALTER ROLE "${authenticatorRole}" SET work_mem = '4MB';
      `);

      // Create Schema and grant access
      await tenantDb.unsafe(`
        CREATE SCHEMA IF NOT EXISTS extensions;
        GRANT USAGE ON SCHEMA extensions TO ${anonRole}, ${authenticatedRole}, ${serviceRole}, "${dbUser}";
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'monitor') THEN
            GRANT USAGE ON SCHEMA monitor TO ${anonRole}, ${authenticatedRole}, ${serviceRole}, "${dbUser}";
          END IF;
        END
        $$;
      `);

      // Ensure global admin roles exist with LOGIN capability and global password
      // (This needs to be done before running supabase.sql to ensure roles exist)
      await tenantDb.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_auth_admin') THEN
            CREATE ROLE supabase_auth_admin LOGIN CREATEROLE CREATEDB NOINHERIT PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          ELSE
            ALTER ROLE supabase_auth_admin LOGIN CREATEROLE CREATEDB NOINHERIT PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          END IF;

          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
            CREATE ROLE supabase_admin LOGIN BYPASSRLS REPLICATION PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          ELSE
            ALTER ROLE supabase_admin LOGIN PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          END IF;

          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
            CREATE ROLE supabase_realtime_admin LOGIN NOINHERIT CREATEROLE REPLICATION PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          ELSE
            ALTER ROLE supabase_realtime_admin LOGIN NOINHERIT CREATEROLE REPLICATION PASSWORD ${pgEscapePassword(this.PG_PASSWORD)};
          END IF;
        END
        $$;
      `);

      // Load and execute full Supabase schema (Auth, Storage, Realtime/Walrus, etc)
      try {
        const schemaSql = await this.loadSupabaseSchema();
        await tenantDb.unsafe(schemaSql);
        await tenantDb.unsafe(renderAuthSchemaOwnershipSql());
        await tenantDb.unsafe(renderPgStatStatementsCompatibilitySql());
        logger.info(
          `[services/database.service] Successfully applied supabase.sql to tenant ${dbName}`,
        );
      } catch (err: unknown) {
        logger.error(
          `[services/database.service] Error applying Supabase schema at ${dbName}`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        throw err;
      }

      // Grant specific tenant roles and schema access to the project owner role to ensure isolation without cluster powers
      await tenantDb.unsafe(`
        GRANT ${anonRole}, ${authenticatedRole}, ${serviceRole} TO "${dbUser}";
        GRANT USAGE ON SCHEMA auth, storage, realtime TO "${dbUser}";
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth, storage, realtime TO "${dbUser}";
        GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA auth, storage, realtime TO "${dbUser}";
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth, storage, realtime TO "${dbUser}";
      `);

      await tenantDb.unsafe(`
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE, CREATE ON SCHEMA public TO "${dbUser}";
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "${dbUser}";
        GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${dbUser}";
        GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO "${dbUser}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO "${dbUser}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${dbUser}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON ROUTINES TO "${dbUser}";
      `);

      // Grant privileges
      await tenantDb.unsafe(`
        GRANT USAGE ON SCHEMA public TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
        GRANT ALL ON SCHEMA public TO ${authenticatedRole}, ${serviceRole};
        GRANT USAGE ON SCHEMA auth TO ${anonRole}, ${authenticatedRole}, ${serviceRole};

        -- GoTrue needs CREATE on public for schema_migrations table
        GRANT ALL ON SCHEMA public TO supabase_auth_admin;
        GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
        ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO supabase_auth_admin;
        ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_auth_admin;

        -- Existing application tables remain reachable by service_role. New
        -- public tables must opt in to Data API exposure with explicit grants.
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
        GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO service_role;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
      `);
    });
  }

  // Delete project database
  async deleteDatabase(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const dbName = await resolveDbName(projectRef);
    const dbUser = resolveRoleName(projectRef);

    try {
      assertValidDbName("dbName", dbName);
      assertValidIdentifier("dbUser", dbUser);

      if (dbName === "postgres") {
        logger.warn(
          `[DatabaseService] Skipping DROP DATABASE for shared database ${dbName} (project ${projectRef})`,
        );
        return { success: true };
      }

      await this.withAdminDb(async (adminDb) => {
        // Terminate connections safely
        try {
          await adminDb`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = ${dbName} AND pid <> pg_backend_pid()
          `;
        } catch (e: unknown) {
          logger.debug("[services/database.service] suppressed error", {
            error: e instanceof Error ? e.message : String(e),
          });
        }

        // Drop database
        await adminDb.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);

        // Drop roles (both the project role and the authenticator role)
        await adminDb.unsafe(`DROP ROLE IF EXISTS "${dbUser}"`);
        const authenticatorRole = resolveAuthenticatorName(projectRef);
        await adminDb.unsafe(`DROP ROLE IF EXISTS "${authenticatorRole}"`);
      });

      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Check database status
  async checkStatus(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const dbName = await resolveDbName(projectRef);

    try {
      assertValidDbName("dbName", dbName);

      return await this.withAdminDb(async (adminDb) => {
        const [dbCount] = await adminDb`
          SELECT 1 FROM pg_database WHERE datname = ${dbName}
        `;

        if (dbCount) {
          return { success: true, output: "active" };
        } else {
          return { success: true, output: "not_found" };
        }
      });
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- Environment Variables (Secrets) Management ---
  // Stored in supacloud_meta.project_secrets table (not files).
  // Edge Runtime reads these dynamically on every function invocation.

  async getSecrets(
    projectRef: string,
  ): Promise<{ name: string; value: string; updated_at?: string }[]> {
    const { sql: metaDb } = await import("../db");
    const rows = await metaDb`
      SELECT name, value, updated_at FROM project_secrets
      WHERE project_ref = ${projectRef}
      ORDER BY name
    `;
    return rows.map((row: Record<string, unknown>) => ({
      name: row.name as string,
      value: decryptSecretIfNeeded(row.value as string),
      updated_at: row.updated_at != null
        ? new Date(row.updated_at as string).toISOString()
        : new Date().toISOString(),
    }));
  }

  async upsertSecret(
    projectRef: string,
    name: string,
    value: string,
  ): Promise<boolean> {
    try {
      const { sql: metaDb } = await import("../db");
      const encryptedValue = encryptSecretIfNeeded(value);
      await metaDb`
        INSERT INTO project_secrets (project_ref, name, value)
        VALUES (${projectRef}, ${name}, ${encryptedValue})
        ON CONFLICT (project_ref, name)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
      return true;
    } catch (err) {
      logger.error("[DatabaseService] Failed to upsert secret", {
        projectRef,
        name,
        error: err,
      });
      return false;
    }
  }

  async deleteSecret(projectRef: string, name: string): Promise<boolean> {
    try {
      const { sql: metaDb } = await import("../db");
      await metaDb`DELETE FROM project_secrets WHERE project_ref = ${projectRef} AND name = ${name}`;
      return true;
    } catch (err) {
      logger.error("[DatabaseService] Failed to delete secret", {
        projectRef,
        name,
        error: err,
      });
      return false;
    }
  }

  // --- Tenant Runtime Management ---
  // Delegates to TenantRuntimeService (TypeScript implementation)
  // Shell-based methods removed — unified to TenantRuntimeService

  async startRuntime(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Import TenantRuntimeService to avoid shell script dual-path
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.startRuntime(projectRef);
      return {
        success: status.status === "running" || status.status === "starting",
        output: `PORT=${status.port}\nGOTRUE_PORT=${status.gotruePort}`,
        error:
          status.health === "unhealthy" ? "Health check failed" : undefined,
      };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stopRuntime(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      await tenantRuntimeService.stopRuntime(projectRef);
      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async pauseRuntime(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      await tenantRuntimeService.pauseProjectRuntime(projectRef);
      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resumeRuntime(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      await tenantRuntimeService.resumeProjectRuntime(projectRef);
      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async restartRuntime(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      await tenantRuntimeService.restartRuntime(projectRef);
      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getRuntimeStatus(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.checkStatus(projectRef);
      return { success: true, output: JSON.stringify(status) };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async pausePostgrest(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.pausePostgrest(projectRef);
      return { success: status.actual !== "error", output: JSON.stringify(status) };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resumePostgrest(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.resumePostgrest(projectRef);
      return { success: status.actual !== "error", output: JSON.stringify(status) };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async restartPostgrest(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.restartPostgrest(projectRef);
      return { success: status.actual !== "error", output: JSON.stringify(status) };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getPostgrestStatus(
    projectRef: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.statusPostgrest(projectRef);
      return { success: true, output: JSON.stringify(status) };
    } catch (error: unknown) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getRuntimePort(projectRef: string): Promise<string> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.checkStatus(projectRef);
      return String(status.port);
    } catch {
      return "";
    }
  }

  // --- Gateway upstream management ---

  async setupUpstream(
    projectRef: string,
    pgrstPort: string,
    gotruePort: string,
    customApiDomain?: string,
    opts?: { functionsPort?: number; storagePort?: number; realtimeApiPort?: number; realtimeWsPort?: number },
  ): Promise<{ success: boolean; error?: string }> {
    const { gatewayService } = await import("./gateway.service");
    return await gatewayService.setupUpstream(
      projectRef,
      pgrstPort,
      gotruePort,
      customApiDomain,
      opts,
    );
  }

  async removeService(
    projectRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { gatewayService } = await import("./gateway.service");
    return await gatewayService.removeService(projectRef);
  }
}

export const databaseService = new DatabaseService();
