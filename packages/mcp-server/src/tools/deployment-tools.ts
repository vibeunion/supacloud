
/**
 * Deployment Management Tools - System-level deployment operations
 */
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const execAsync = promisify(exec);

export function registerDeploymentTools(server: McpServer): void {
    // ── Deploy Web Console ──
    server.tool(
        "deploy_web_console",
        "Deploy or update Web Console frontend container",
        {
            port: z.number().default(3000).describe("Console running port (default 3000)"),
            apiUrl: z.string().optional().describe("Management API URL (default http://localhost:9090)"),
        },
        async ({ port, apiUrl }) => {
            try {
                // Determine script path - prefer environment variable, otherwise look in project root
                let scriptPath = process.env.SUPACLOUD_SCRIPTS_DIR 
                    ? path.join(process.env.SUPACLOUD_SCRIPTS_DIR, "deploy_web_console.sh")
                    : path.resolve(process.cwd(), "scripts/deploy_web_console.sh");
                
                // If not in current directory, try one level up (may be needed in monorepo dev environment)
                if (!fs.existsSync(scriptPath)) {
                    const parentPath = path.resolve(process.cwd(), "../..", "scripts/deploy_web_console.sh");
                    if (fs.existsSync(parentPath)) {
                        scriptPath = parentPath;
                    } else if (process.env.SUPACLOUD_HOME) {
                        scriptPath = path.join(process.env.SUPACLOUD_HOME, "scripts/deploy_web_console.sh");
                    }
                }

                if (!fs.existsSync(scriptPath)) {
                    throw new Error(`Deployment script not found: ${scriptPath}. Please ensure scripts/deploy_web_console.sh exists, or set SUPACLOUD_SCRIPTS_DIR environment variable.`);
                }

                // Build environment variables
                const env = {
                    ...process.env,
                    CONSOLE_PORT: port.toString(),
                    API_URL: apiUrl || "http://localhost:9090",
                };

                // Execute script
                // Note: Windows environment may need wsl or bash, assuming bash is available (e.g., git bash or wsl)
                // If on native Windows without bash, this may fail, but SupaCloud seems targeted at Linux/Unix environments
                // User environment is Windows, but previous install.sh are all bash scripts, indicating user may have bash (Git Bash, WSL, etc.)
                
                const { stdout, stderr } = await execAsync(`bash "${scriptPath}"`, { env });

                return {
                    content: [
                        {
                            type: "text",
                            text: `✅ Deployment script executed successfully\n\n${stdout}\n${stderr ? `Warnings/Errors:\n${stderr}` : ""}`,
                        },
                    ],
                };
            } catch (error: unknown) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `❌ Deployment failed: ${(error instanceof Error ? error.message : String(error))}\n${(error as { stderr?: string }).stderr || ""}`,
                        },
                    ],
                };
            }
        }
    );
}
