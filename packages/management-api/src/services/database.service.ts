import { nanoid } from "nanoid";
import { shellService } from "./shell.service";
import { SQL } from "bun";
import { $ } from "bun";
import { ValidationUtils } from "../utils/validation";

export class DatabaseService {
  private readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
  private readonly PG_PORT = parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || "6432");
  private readonly PG_USER = process.env.PG_USER || "postgres";
  private readonly PG_PASSWORD = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "postgres";
  private readonly PG_DATABASE = process.env.PG_DATABASE || "postgres";

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
    const minGb = parseInt(process.env.MIN_DISK_GB || "10");
    const minKb = minGb * 1024 * 1024;

    let targetDir = process.env.PG_DATA_DIR || "/var/lib/pgsql/data";

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
    } catch (error) {
      if (error instanceof Error && error.message.includes("Insufficient disk space")) {
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
      ValidationUtils.assertValidDbName("dbName", dbName);
      ValidationUtils.assertValidIdentifier("dbUser", dbUser);

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
    } catch (error: any) {
      return { success: false, error: error.message };
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
      ValidationUtils.assertValidIdentifier("authenticatorRole", authenticatorRole);

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

      // Grant privileges
      await tenantDb.unsafe(`
        GRANT USAGE ON SCHEMA public TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
        GRANT ALL ON SCHEMA public TO ${authenticatedRole}, ${serviceRole};
        GRANT USAGE ON SCHEMA auth TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
      `);
    });
  }

  // Delete project database
  async deleteDatabase(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;

    try {
      ValidationUtils.assertValidDbName("dbName", dbName);
      ValidationUtils.assertValidIdentifier("dbUser", dbUser);

      await this.withAdminDb(async (adminDb) => {
        // Terminate connections safely
        try {
          await adminDb`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = ${dbName} AND pid <> pg_backend_pid()
          `;
        } catch { /* ignore */ }

        // Drop database
        await adminDb.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);

        // Drop role
        await adminDb.unsafe(`DROP ROLE IF EXISTS "${dbUser}"`);
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Check database status
  async checkStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const dbName = `supa_${projectRef}`;

    try {
      ValidationUtils.assertValidDbName("dbName", dbName);

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
    } catch (error: any) {
      return { success: false, output: "", error: error.message };
    }
  }

  // --- Environment Variables (Secrets) Management ---

  async getSecrets(projectRef: string): Promise<{ name: string; value: string }[]> {
    const result = await shellService.execute("key_manager.sh", ["list-secrets", projectRef]);
    if (!result.success) return [];
    try {
      return JSON.parse(result.output);
    } catch {
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
