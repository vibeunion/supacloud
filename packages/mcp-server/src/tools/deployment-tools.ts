
/**
 * 部署管理工具集 - 系统级部署操作
 */
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const execAsync = promisify(exec);

export function registerDeploymentTools(server: McpServer): void {
    // ── 部署 Web 控制台 ──
    server.tool(
        "deploy_web_console",
        "部署或更新 Web 控制台前端容器",
        {
            port: z.number().default(3000).describe("控制台运行端口 (默认 3000)"),
            apiUrl: z.string().optional().describe("Management API 地址 (默认 http://localhost:9090)"),
        },
        async ({ port, apiUrl }) => {
            try {
                // 确定脚本路径 - 优先使用环境变量，否则在项目根目录查找
                let scriptPath = process.env.SUPACLOUD_SCRIPTS_DIR 
                    ? path.join(process.env.SUPACLOUD_SCRIPTS_DIR, "deploy_web_console.sh")
                    : path.resolve(process.cwd(), "scripts/deploy_web_console.sh");
                
                // 如果当前目录没有，尝试向上一级查找（在 monorepo 开发环境可能需要）
                if (!fs.existsSync(scriptPath)) {
                    const parentPath = path.resolve(process.cwd(), "../..", "scripts/deploy_web_console.sh");
                    if (fs.existsSync(parentPath)) {
                        scriptPath = parentPath;
                    } else if (process.env.SUPACLOUD_HOME) {
                        scriptPath = path.join(process.env.SUPACLOUD_HOME, "scripts/deploy_web_console.sh");
                    }
                }

                if (!fs.existsSync(scriptPath)) {
                    throw new Error(`找不到部署脚本: ${scriptPath}。请确保 scripts/deploy_web_console.sh 存在，或设置 SUPACLOUD_SCRIPTS_DIR 环境变量。`);
                }

                // 构建环境变量
                const env = {
                    ...process.env,
                    CONSOLE_PORT: port.toString(),
                    API_URL: apiUrl || "http://localhost:9090",
                };

                // 执行脚本
                // 注意：Windows 环境下可能需要 wsl 或 bash，这里假设环境中有 bash (如 git bash 或 wsl)
                // 如果是在 Windows 原生环境且没有 bash，这可能会失败，但 SupaCloud 似乎是面向 Linux/Unix 环境的
                // 用户环境是 Windows，但之前的 install.sh 都是 bash 脚本，说明用户可能有 bash 环境 (Git Bash, WSL 等)
                
                const { stdout, stderr } = await execAsync(`bash "${scriptPath}"`, { env });

                return {
                    content: [
                        {
                            type: "text",
                            text: `✅ 部署脚本执行成功\n\n${stdout}\n${stderr ? `Warnings/Errors:\n${stderr}` : ""}`,
                        },
                    ],
                };
            } catch (error: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `❌ 部署失败: ${error.message}\n${error.stderr || ""}`,
                        },
                    ],
                };
            }
        }
    );
}
