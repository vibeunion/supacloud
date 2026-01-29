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
}

export const databaseService = new DatabaseService();
