import { nanoid } from "nanoid";
import { shellService } from "./shell.service";

export class DatabaseService {
  // 生成数据库密码
  generatePassword(): string {
    return nanoid(24);
  }

  // 创建项目数据库和角色
  async createDatabase(projectRef: string, password: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("db_manager.sh", ["create", projectRef, password]);
    return result;
  }

  // 删除项目数据库和角色
  async deleteDatabase(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("db_manager.sh", ["delete", projectRef]);
    return result;
  }

  // 检查数据库状态
  async checkStatus(projectRef: string): Promise<{ success: boolean; output: string; error?: string }> {
    const result = await shellService.execute("db_manager.sh", ["status", projectRef]);
    return result;
  }

  // --- 环境变量 (Secrets) 管理 ---

  async getSecrets(projectRef: string): Promise<any[]> {
    // 逻辑：调用底层脚本或直接操作元数据库
    // 注意：目前的 DatabaseService 主要是 Shell 包装器
    // 在实际生产中，这里应该调用 sql 客户端操作 supacloud_meta
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

  // --- 租户运行时管理（方案C: per-tenant PostgREST） ---

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

  // --- Kong upstream 管理 ---

  async setupUpstream(projectRef: string, port: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("gateway_manager.sh", ["setup-upstream", projectRef, port]);
    return result;
  }

  async removeService(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("gateway_manager.sh", ["remove-service", projectRef]);
    return result;
  }
}

export const databaseService = new DatabaseService();
