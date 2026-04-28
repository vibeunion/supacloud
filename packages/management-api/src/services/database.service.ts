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

/** Escape a string value for use inside PostgreSQL dollar-quoted strings */
function pgEscapePassword(password: string): string {
  // Use dollar-quoting with unique tag to safely embed passwords
  // The tag includes a hash and a random segment to avoid collision with password content
  const randomSegment = crypto.randomUUID().slice(0, 8);
  const tag = `pw${Bun.hash(password).toString(36).slice(0, 4)}${randomSegment}`;
  return `$${tag}$${password}$${tag}$`;
}

export class DatabaseService {
  private readonly PG_HOST = config.pgHost;
  private readonly PG_PORT = config.pgPort;
  private readonly PG_USER = config.pgUser;
  private readonly PG_PASSWORD = config.pgPassword;
  private readonly PG_DATABASE = config.pgDatabase;

  // Generate secure random password
  generatePassword(length = 24): string {
    const charset =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let ret = "";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      ret += charset[bytes[i] % charset.length];
    }
    return ret;
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
  async createDatabase(
    projectRef: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const dbName = generateDbName(projectRef);
    const dbUser = resolveRoleName(projectRef);

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

        if (dbExists) {
          return;
        }

        // Create database - use double quotes to support identifiers with hyphens
        await adminDb.unsafe(
          `CREATE DATABASE "${dbName}" OWNER ${this.PG_USER}`,
        );

        // Create role - limit connections for low-resource environments (prevent connection exhaustion)
        await adminDb.unsafe(
          `CREATE ROLE "${dbUser}" LOGIN CONNECTION LIMIT 20 PASSWORD ${pgEscapePassword(password)}`,
        );

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

      // Apply schema independently
      await this.applySupabaseSchema(dbName, projectRef, password);

      await this.withAdminDb(async (adminDb) => {
        await adminDb.unsafe(`
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
      const coreExts = ["pgjwt", "pg_net", "pgsodium", "vault", "pg_graphql"];
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
        GRANT USAGE ON SCHEMA extensions TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
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
        END
        $$;
      `);

      // Load and execute full Supabase schema (Auth, Storage, Realtime/Walrus, etc)
      try {
        const schemaSql = await this.loadSupabaseSchema();
        await tenantDb.unsafe(schemaSql);
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

        -- Ensure service_role has access to all tables created by postgres
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
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
    try {
      const { sql: metaDb } = await import("../db");
      const rows = await metaDb`
        SELECT name, value, updated_at FROM project_secrets
        WHERE project_ref = ${projectRef}
        ORDER BY name
      `;
      return rows.map((r: Record<string, unknown>) => ({
        name: r.name as string,
        value: decryptSecretIfNeeded(r.value as string),
        updated_at:
          (r.updated_at != null
            ? new Date(r.updated_at as string).toISOString()
            : null) ?? new Date().toISOString(),
      }));
    } catch (err) {
      logger.error("[DatabaseService] Failed to get secrets", {
        projectRef,
        error: err,
      });
      return [];
    }
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

  async getRuntimePort(projectRef: string): Promise<string> {
    const { tenantRuntimeService } = await import("./tenant-runtime.service");
    try {
      const status = await tenantRuntimeService.checkStatus(projectRef);
      return String(status.port);
    } catch {
      return "";
    }
  }

  // --- Kong upstream management ---

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
