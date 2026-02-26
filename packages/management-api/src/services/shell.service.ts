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

    try {
      const result = await $`bash ${scriptPath} ${args}`.text();
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
