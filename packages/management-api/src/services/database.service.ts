import { config } from "../config";
import { nanoid } from "nanoid";
import { logger } from "../utils/logger";
import { shellService } from "./shell.service";
import { SQL } from "bun";
import { $ } from "bun";
import { assertValidIdentifier, assertValidDbName } from "../utils/validation";

export class DatabaseService {
  private readonly PG_HOST = config.pgHost;
  private readonly PG_PORT = config.pgPort;
  private readonly PG_USER = config.pgUser;
  private readonly PG_PASSWORD = config.pgPassword;
  private readonly PG_DATABASE = config.pgDatabase;

  // Generate secure random password
  generatePassword(length = 24): string {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let ret = '';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      ret += charset[bytes[i] % charset.length];
    }
    return ret;
  }

  // Gateway DB connection - use explicit configuration to avoid Bun SQL bugs
  private getAdminDb(): SQL {
    return new SQL({
      hostname: this.PG_HOST,
      port: this.PG_PORT,
      database: this.PG_DATABASE,
      username: this.PG_USER,
      password: this.PG_PASSWORD,
    });
  }

  // Tenant project DB connection - use explicit configuration to avoid Bun SQL bugs
  private getTenantDb(dbName: string): SQL {
    return new SQL({
      hostname: this.PG_HOST,
      port: this.PG_PORT,
      database: dbName,
      username: this.PG_USER,
      password: this.PG_PASSWORD,
    });
  }

  // Unified execution wrap for Admin DB to ensure connection release
  private async withAdminDb<T>(operation: (db: SQL) => Promise<T>): Promise<T> {
    const db = this.getAdminDb();
    try {
      return await operation(db);
    } finally {
      await db.close();
    }
  }

  // Unified execution wrap for Tenant DB to ensure connection release
  private async withTenantDb<T>(dbName: string, operation: (db: SQL) => Promise<T>): Promise<T> {
    const db = this.getTenantDb(dbName);
    try {
      return await operation(db);
    } finally {
      await db.close();
    }
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
        const lines = dfOut.text().trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].trim().split(/\s+/);
          const availKb = parseInt(parts[3]);

          if (availKb < minKb) {
            throw new Error(`Insufficient disk space on ${targetDir}. Available: ${Math.floor(availKb / 1024)}MB. Required minimum: ${minGb}GB.`);
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && (error instanceof Error ? error.message : String(error)).includes("Insufficient disk space")) {
        throw error;
      }
    }
  }

  // Create tenant database
  async createDatabase(projectRef: string, password: string): Promise<{ success: boolean; error?: string }> {
    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;

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
        await adminDb.unsafe(`CREATE DATABASE "${dbName}" OWNER ${this.PG_USER}`);

        // Create role - limit connections for low-resource environments (prevent connection exhaustion)
        await adminDb.unsafe(`CREATE ROLE "${dbUser}" LOGIN CONNECTION LIMIT 20 PASSWORD '${password}'`);

        // Set kernel-level configs for resource exhaustion prevention
        await adminDb.unsafe(`
          ALTER ROLE "${dbUser}" SET statement_timeout = '30s';
          ALTER ROLE "${dbUser}" SET idle_in_transaction_session_timeout = '1min';
          ALTER ROLE "${dbUser}" SET work_mem = '4MB';
        `);

        // Grant privileges
        await adminDb.unsafe(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}"`);
      });

      // Apply schema independently 
      await this.applySupabaseSchema(dbName, projectRef, password);

      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  // Apply Supabase Schema
  private async applySupabaseSchema(dbName: string, projectRef: string, password: string): Promise<void> {
    await this.withTenantDb(dbName, async (tenantDb) => {
      // Create extensions
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgjwt"`);

      // Create API roles - use double quotes to support hyphens
      const authenticatorRole = `authenticator_${projectRef}`;
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
            CREATE ROLE ${anonRole} NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${authenticatedRole}') THEN
            CREATE ROLE ${authenticatedRole} NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${serviceRole}') THEN
            CREATE ROLE ${serviceRole} NOLOGIN;
          END IF;
        END
        $$;
      `);

      await tenantDb.unsafe(`
        CREATE ROLE "${authenticatorRole}" CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD '${password}';
        GRANT ${anonRole}, ${authenticatedRole}, ${serviceRole} TO "${authenticatorRole}";

        -- Set shorter timeout and same memory limits for API Role to prevent cascade failures
        ALTER ROLE "${authenticatorRole}" SET statement_timeout = '15s';
        ALTER ROLE "${authenticatorRole}" SET idle_in_transaction_session_timeout = '30s';
        ALTER ROLE "${authenticatorRole}" SET work_mem = '4MB';
      `);

      // Create Schema
      await tenantDb.unsafe(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE SCHEMA IF NOT EXISTS realtime;
      `);

      // Create supabase_auth_admin role (used by GoTrue for migrations)
      await tenantDb.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_auth_admin') THEN
            CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}';
          END IF;
        END
        $$;
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
      `);
    });
  }

  // Delete project database
  async deleteDatabase(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;

    try {
      assertValidDbName("dbName", dbName);
      assertValidIdentifier("dbUser", dbUser);

      await this.withAdminDb(async (adminDb) => {
        // Terminate connections safely
        try {
          await adminDb`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = ${dbName} AND pid <> pg_backend_pid()
          `;
        } catch (e: unknown) { logger.debug("[services/database.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

        // Drop database
        await adminDb.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);

        // Drop roles (both the project role and the authenticator role)
        await adminDb.unsafe(`DROP ROLE IF EXISTS "${dbUser}"`);
        const authenticatorRole = `authenticator_${projectRef}`;
        await adminDb.unsafe(`DROP ROLE IF EXISTS "${authenticatorRole}"`);
      });

      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  // Check database status
  async checkStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const dbName = `supa_${projectRef}`;

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
      return { success: false, output: "", error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  // --- Environment Variables (Secrets) Management ---

  async getSecrets(projectRef: string): Promise<{ name: string; value: string }[]> {
    const result = await shellService.execute("key_manager.sh", ["list-secrets", projectRef]);
    if (!result.success) return [];
    try {
      return JSON.parse(result.output);
    } catch (err: unknown) {
      logger.warn("[DatabaseService] Failed to execute database diagnostic script", { error: err });
      return [];
    }
  }

  async upsertSecret(projectRef: string, name: string, value: string): Promise<boolean> {
    const result = await shellService.execute("key_manager.sh", ["set-secret", projectRef, name, value]);
    return result.success;
  }

  async deleteSecret(projectRef: string, name: string): Promise<boolean> {
    const result = await shellService.execute("key_manager.sh", ["delete-secret", projectRef, name]);
    return result.success;
  }

  // --- Tenant Runtime Management ---

  async startRuntime(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const result = await shellService.execute("tenant_runtime.sh", ["start", projectRef]);
    return result;
  }

  async stopRuntime(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("tenant_runtime.sh", ["stop", projectRef]);
    return result;
  }

  async restartRuntime(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("tenant_runtime.sh", ["restart", projectRef]);
    return result;
  }

  async getRuntimeStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const result = await shellService.execute("tenant_runtime.sh", ["status", projectRef]);
    return result;
  }

  async getRuntimePort(projectRef: string): Promise<string> {
    const result = await shellService.execute("tenant_runtime.sh", ["port", projectRef]);
    return result.success ? result.output.trim() : "";
  }

  // --- Kong upstream management ---

  async setupUpstream(projectRef: string, pgrstPort: string, gotruePort: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("gateway_manager.sh", ["setup-upstream", projectRef, pgrstPort, gotruePort]);
    return result;
  }

  async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("gateway_manager.sh", ["remove-service", projectRef]);
    return result;
  }
}

export const databaseService = new DatabaseService();
