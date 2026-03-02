import { nanoid } from "nanoid";
import { shellService } from "./shell.service";
import { SQL } from "bun";
import { $ } from "bun";
import path from "node:path";
import fs from "node:fs/promises";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { gatewayService } from "./gateway.service";


export class DatabaseService {
  private readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
  private readonly PG_PORT = parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || "6432");
  private readonly PG_USER = process.env.PG_USER || "postgres";
  private readonly PG_PASSWORD = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "postgres";
  private readonly PG_DATABASE = process.env.PG_DATABASE || "postgres";

  // 生成安全随机密码
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

  // 管理库连接 - 使用显式配置避免 Bun SQL bug
  private getAdminDb(): SQL {
    return new SQL({
      hostname: this.PG_HOST,
      port: this.PG_PORT,
      database: this.PG_DATABASE,
      username: this.PG_USER,
      password: this.PG_PASSWORD,
    });
  }

  // 租户项目库连接 - 使用显式配置避免 Bun SQL bug
  private getTenantDb(dbName: string): SQL {
    return new SQL({
      hostname: this.PG_HOST,
      port: this.PG_PORT,
      database: dbName,
      username: this.PG_USER,
      password: this.PG_PASSWORD,
    });
  }

  // 磁盘空间预检:防止 WAL 写满导致集群崩溃
  private async checkDiskSpace(): Promise<void> {
    const minGb = parseInt(process.env.MIN_DISK_GB || "10");
    const minKb = minGb * 1024 * 1024;

    let targetDir = process.env.PG_DATA_DIR || "/var/lib/pgsql/data";

    try {
      await fs.access(targetDir);
    } catch {
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

  // 创建租户数据库
  async createDatabase(projectRef: string, password: string): Promise<{ success: boolean; error?: string }> {
    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;

    try {
      await this.checkDiskSpace();

      const adminDb = this.getAdminDb();
      try {
        // 检查数据库是否已存在
        const [dbExists] = await adminDb`
          SELECT 1 FROM pg_database WHERE datname = ${dbName}
        `;

        if (dbExists) {
          return { success: true };
        }

        // 创建数据库
        await adminDb.unsafe(`CREATE DATABASE ${dbName} OWNER ${this.PG_USER}`);

        // 创建角色
        await adminDb.unsafe(`CREATE ROLE ${dbUser} LOGIN PASSWORD '${password}'`);

        // 授权
        await adminDb.unsafe(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser}`);

        // 应用 Supabase Schema
        await this.applySupabaseSchema(dbName, projectRef, password);

        return { success: true };
      } finally {
        await adminDb.close();
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // 应用 Supabase Schema
  private async applySupabaseSchema(dbName: string, projectRef: string, password: string): Promise<void> {
    const tenantDb = this.getTenantDb(dbName);

    try {
      // 创建扩展
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgjwt"`);
      await tenantDb.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgsodium"`);

      // 创建 API 角色
      const authenticatorRole = `authenticator_${projectRef}`;
      const anonRole = `anon`;
      const authenticatedRole = `authenticated`;
      const serviceRole = `service_role`;

      await tenantDb.unsafe(`
        CREATE ROLE IF NOT EXISTS ${anonRole} NOLOGIN;
        CREATE ROLE IF NOT EXISTS ${authenticatedRole} NOLOGIN;
        CREATE ROLE IF NOT EXISTS ${serviceRole} NOLOGIN;
      `);

      await tenantDb.unsafe(`
        CREATE ROLE ${authenticatorRole} NOINHERIT LOGIN PASSWORD '${password}';
        GRANT ${anonRole}, ${authenticatedRole}, ${serviceRole} TO ${authenticatorRole};
      `);

      // 创建 Schema
      await tenantDb.unsafe(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE SCHEMA IF NOT EXISTS realtime;
      `);

      // 授权
      await tenantDb.unsafe(`
        GRANT USAGE ON SCHEMA public TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
        GRANT ALL ON SCHEMA public TO ${authenticatedRole}, ${serviceRole};
        GRANT USAGE ON SCHEMA auth TO ${anonRole}, ${authenticatedRole}, ${serviceRole};
      `);

    } finally {
      await tenantDb.close();
    }
  }

  // 删除项目数据库
  async deleteDatabase(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const dbName = `supa_${projectRef}`;
    const dbUser = `role_${projectRef}`;

    try {
      const adminDb = this.getAdminDb();
      try {
        // 终止连接 (忽略错误，因为可能没有活跃连接)
        try {
          await adminDb.unsafe(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = '${dbName}' AND pid <> pg_backend_pid()
          `);
        } catch { /* ignore */ }

        // 删除数据库
        await adminDb.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);

        // 删除角色
        await adminDb.unsafe(`DROP ROLE IF EXISTS ${dbUser}`);

        return { success: true };
      } finally {
        await adminDb.close();
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // 检查数据库状态
  async checkStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const dbName = `supa_${projectRef}`;

    try {
      const adminDb = this.getAdminDb();
      try {
        const [dbCount] = await adminDb`
          SELECT 1 FROM pg_database WHERE datname = ${dbName}
        `;

        if (dbCount) {
          return { success: true, output: "active" };
        } else {
          return { success: true, output: "not_found" };
        }
      } finally {
        await adminDb.close();
      }
    } catch (error: any) {
      return { success: false, output: "", error: error.message };
    }
  }

  // --- 环境变量 (Secrets) 管理 ---
  // Note: key_manager.sh 仍需 Shell 执行（依赖 age/gpg 加密工具）

  async getSecrets(projectRef: string): Promise<any[]> {
    const result = await shellService.execute("key_manager.sh", ["list-secrets", projectRef]);
    if (!result.success) return [];
    try { return JSON.parse(result.output); } catch { return []; }
  }

  async upsertSecret(projectRef: string, name: string, value: string): Promise<boolean> {
    const result = await shellService.execute("key_manager.sh", ["set-secret", projectRef, name, value]);
    return result.success;
  }

  async deleteSecret(projectRef: string, name: string): Promise<boolean> {
    const result = await shellService.execute("key_manager.sh", ["delete-secret", projectRef, name]);
    return result.success;
  }

  // --- 租户运行时管理（代理到 tenantRuntimeService，并适配返回类型）---

  async startRuntime(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const s = await tenantRuntimeService.startRuntime(projectRef);
    const ok = s.status === "running";
    return { success: ok, output: `PORT=${s.port} GOTRUE_PORT=${s.gotruePort} STATUS=${s.status}`, ...(ok ? {} : { error: s.health }) };
  }

  async stopRuntime(projectRef: string): Promise<{ success: boolean; error?: string }> {
    await tenantRuntimeService.stopRuntime(projectRef);
    return { success: true };
  }

  async restartRuntime(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const s = await tenantRuntimeService.restartRuntime(projectRef);
    const ok = s.status === "running";
    return { success: ok, ...(ok ? {} : { error: s.health }) };
  }

  async getRuntimeStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const s = await tenantRuntimeService.checkStatus(projectRef);
    return { success: s.status !== "error", output: `STATUS=${s.status} PORT=${s.port} HEALTH=${s.health}` };
  }

  async getRuntimePort(projectRef: string): Promise<string> {
    const s = await tenantRuntimeService.checkStatus(projectRef);
    return s.port ? String(s.port) : "";
  }

  // --- Kong upstream 管理（代理到 gatewayService）---

  async setupUpstream(projectRef: string, pgrstPort: string, gotruePort: string): Promise<{ success: boolean; error?: string }> {
    return gatewayService.setupUpstream(projectRef, pgrstPort, gotruePort);
  }

  async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
    return gatewayService.removeService(projectRef);
  }
}

export const databaseService = new DatabaseService();
