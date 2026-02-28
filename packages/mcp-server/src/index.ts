#!/usr/bin/env node
/**
 * @supacloud/mcp-server
 *
 * AI-native 的 Supabase 基础设施管理 MCP Server。
 *
 * 使用方式 (Claude Desktop / Cursor / Windsurf):
 * ```json
 * {
 *   "mcpServers": {
 *     "supacloud": {
 *       "command": "npx",
 *       "args": ["-y", "@supacloud/mcp-server"],
 *       "env": {
 *         "SUPACLOUD_HOST": "1.2.3.4",
 *         "SUPACLOUD_SSH_USER": "root",
 *         "SUPACLOUD_SSH_PORT": "22",
 *         "SUPACLOUD_SSH_KEY": "~/.ssh/id_rsa",
 *         "SUPACLOUD_API_URL": "http://1.2.3.4:9090",
 *         "SUPACLOUD_API_TOKEN": ""
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * 环境变量说明:
 * - SUPACLOUD_HOST:       目标服务器 IP / 域名 (必填)
 * - SUPACLOUD_SSH_USER:   SSH 用户名 (默认 root)
 * - SUPACLOUD_SSH_PORT:   SSH 端口 (默认 22)
 * - SUPACLOUD_SSH_KEY:    SSH 私钥路径 (默认 ~/.ssh/id_rsa)
 * - SUPACLOUD_SSH_PASS:   SSH 密码 (优先使用 key)
 * - SUPACLOUD_API_URL:    Management API 地址 (默认 http://{HOST}:9090)
 * - SUPACLOUD_API_TOKEN:  Management API Master Token (安装后填入)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SshTransport } from "./transports/ssh";
import { HttpTransport } from "./transports/http";
import { registerSshTools } from "./tools/ssh-tools";
import { registerProjectTools } from "./tools/project-tools";
import { registerAdvancedTools } from "./tools/advanced-tools";
import { registerDeploymentTools } from "./tools/deployment-tools";
import { resolve } from "path";
import { homedir } from "os";

// ── 解析环境变量 ──
const HOST = process.env.SUPACLOUD_HOST ?? "";
const SSH_USER = process.env.SUPACLOUD_SSH_USER ?? "root";
const SSH_PORT = parseInt(process.env.SUPACLOUD_SSH_PORT ?? "22", 10);
const SSH_KEY = process.env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa");
const SSH_PASS = process.env.SUPACLOUD_SSH_PASS ?? "";
const API_URL = process.env.SUPACLOUD_API_URL ?? (HOST ? `http://${HOST}:9090` : "");
const API_TOKEN = process.env.SUPACLOUD_API_TOKEN ?? "";

// ── 创建 MCP Server ──
const server = new McpServer({
    name: "supacloud",
    version: "0.1.0",
});

// ── 注册 SSH 工具 (始终可用) ──
if (HOST) {
    const ssh = new SshTransport({
        host: HOST,
        port: SSH_PORT,
        username: SSH_USER,
        privateKeyPath: SSH_KEY || undefined,
        password: SSH_PASS || undefined,
    });
    registerSshTools(server, ssh);
}

// ── 注册 HTTP 工具 (需要 API 地址) ──
if (API_URL) {
    const http = new HttpTransport({
        baseUrl: API_URL,
        token: API_TOKEN,
    });
    registerProjectTools(server, http);
    registerAdvancedTools(server, http);
}

// ── 注册部署工具 (本地 Docker 操作) ──
registerDeploymentTools(server);

// ── 如果两者都没配置，注册一个帮助工具 ──
if (!HOST && !API_URL) {
    server.tool(
        "setup_help",
        "显示 SupaCloud MCP Server 配置指南",
        {},
        async () => ({
            content: [
                {
                    type: "text",
                    text: [
                        "⚠️ SupaCloud MCP Server 尚未配置目标服务器。",
                        "",
                        "请在 MCP 配置中设置以下环境变量:",
                        "",
                        "  SUPACLOUD_HOST       - 服务器 IP 或域名 (必填)",
                        "  SUPACLOUD_SSH_USER   - SSH 用户名 (默认 root)",
                        "  SUPACLOUD_SSH_KEY    - SSH 私钥路径 (默认 ~/.ssh/id_rsa)",
                        "  SUPACLOUD_API_URL    - Management API 地址 (安装后自动推断)",
                        "  SUPACLOUD_API_TOKEN  - Master Token (安装后填入)",
                        "",
                        "配置示例 (claude_desktop_config.json):",
                        JSON.stringify(
                            {
                                mcpServers: {
                                    supacloud: {
                                        command: "npx",
                                        args: ["-y", "@supacloud/mcp-server"],
                                        env: {
                                            SUPACLOUD_HOST: "YOUR_SERVER_IP",
                                            SUPACLOUD_SSH_KEY: "~/.ssh/id_rsa",
                                        },
                                    },
                                },
                            },
                            null,
                            2
                        ),
                    ].join("\n"),
                },
            ],
        })
    );
}

// ── 启动 stdio 传输 ──
async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("SupaCloud MCP Server failed to start:", err);
    process.exit(1);
});
