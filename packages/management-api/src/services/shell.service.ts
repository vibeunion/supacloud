interface ShellError extends Error { stdout: Buffer; stderr: Buffer; }

import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";

export class ShellService {
  private scriptsPath: string;

  constructor() {
    this.scriptsPath = config.scriptsPath;
  }

  // Execute script and return result
  async execute(script: string, args: string[], timeoutMs: number = 30_000): Promise<{ success: boolean; output: string; error?: string }> {
    const scriptPath = `${this.scriptsPath}/${script}`;

    // Parse database connection info from DATABASE_URL
    const dbUrl = config.databaseUrl;
    const dbUrlMatch = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\//);

    // Build environment variables
    const env: Record<string, string> = {
      ...process.env,
      PG_HOST: config.pgHost,
      PG_PORT: String(config.pgPort),
      PG_USER: config.pgUser,
      PGPASSWORD: config.pgPassword,
    };

    let timedOut = false;
    const proc = Bun.spawn(["bash", scriptPath, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (timedOut) {
        logger.warn(`[ShellService] Script ${script} timed out after ${timeoutMs}ms`);
        return { success: false, output: "", error: `timeout after ${timeoutMs}ms` };
      }

      if (exitCode === 0) {
        return { success: true, output: stdout.trim() };
      }

      return {
        success: false,
        output: "",
        error: stderr.trim() || stdout.trim() || `Script exited with code ${exitCode}`,
      };
    } catch (error: unknown) {
      if (timedOut) {
        logger.warn(`[ShellService] Script ${script} timed out after ${timeoutMs}ms`);
        return { success: false, output: "", error: `timeout after ${timeoutMs}ms` };
      }
      return {
        success: false,
        output: "",
        error: (error as ShellError).stderr?.toString() || (error instanceof Error ? error.message : String(error)) || "Unknown error",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Execute a system command (not a script)
  async executeCommand(command: string, args: string[] = []): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      // Safe execution using Bun Shell's built-in argument escaping
      const result = await $`${command} ${args}`.text();
      return { success: true, output: result.trim() };
    } catch (error: unknown) {
      const stderr = (error as ShellError).stderr?.toString() || "";
      const stdout = (error as ShellError).stdout?.toString() || "";
      return {
        success: false,
        output: stdout + stderr,
        error: stderr || (error instanceof Error ? error.message : String(error)) || "Command failed",
      };
    }
  }

  // Check if script exists
  async scriptExists(script: string): Promise<boolean> {
    const scriptPath = `${this.scriptsPath}/${script}`;
    try {
      await $`test -f ${scriptPath}`;
      return true;
    } catch (err: unknown) {
      logger.warn("[ShellService] Failed to check script existence", { error: err });
      return false;
    }
  }
}

export const shellService = new ShellService();
