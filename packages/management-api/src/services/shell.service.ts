import { $ } from "bun";
import { config } from "../config";

export class ShellService {
  private scriptsPath: string;

  constructor() {
    this.scriptsPath = config.scriptsPath;
  }

  // Execute script and return result
  async execute(script: string, args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
    const scriptPath = `${this.scriptsPath}/${script}`;

    // Parse database connection info from DATABASE_URL
    const dbUrl = config.databaseUrl;
    const dbUrlMatch = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\//);

    // Build environment variables
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

  // Execute a system command (not a script)
  async executeCommand(command: string, args: string[] = []): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      const cmd = args.length > 0 ? `${command} ${args.join(" ")}` : command;
      const result = await $`${{ raw: cmd }}`.text();
      return { success: true, output: result.trim() };
    } catch (error: any) {
      const stderr = error.stderr?.toString() || "";
      const stdout = error.stdout?.toString() || "";
      return {
        success: false,
        output: stdout + stderr,
        error: stderr || error.message || "Command failed",
      };
    }
  }

  // Check if script exists
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
