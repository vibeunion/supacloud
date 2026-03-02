import { $ } from "bun";
import { config } from "../config";

export class ShellService {
  private scriptsPath: string;

  constructor() {
    this.scriptsPath = config.scriptsPath;
  }

  // 执行脚本并返回结果
  async execute(script: string, args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
    const scriptPath = `${this.scriptsPath}/${script}`;

    // 从 DATABASE_URL 解析数据库连接信息
    const dbUrl = config.databaseUrl;
    const dbUrlMatch = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\//);

    // 构建环境变量
    const env: Record<string, string> = {
      ...process.env,
      PG_HOST: process.env.PG_HOST || dbUrlMatch?.[3] || "localhost",
      PG_PORT: process.env.PG_PORT || dbUrlMatch?.[4] || "5432",
      PG_USER: process.env.PG_USER || dbUrlMatch?.[1] || "postgres",
      PGPASSWORD: process.env.PGPASSWORD || dbUrlMatch?.[2] || "postgres",
    };

    try {
      const result = await $`bash ${scriptPath} ${args}`.env(env).text();
      return { success: true, output: result.trim() };
    } catch (error: any) {
      return {
        success: false,
        output: "",
        error: error.stderr?.toString() || error.message || "Unknown error",
      };
    }
  }

  // 检查脚本是否存在
  async scriptExists(script: string): Promise<boolean> {
    const scriptPath = `${this.scriptsPath}/${script}`;
    try {
      await $`test -f ${scriptPath}`;
      return true;
    } catch {
      return false;
    }
  }
}

export const shellService = new ShellService();
