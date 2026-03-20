#!/usr/bin/env node
/**
 * @supacloud/mcp-server
 *
 * AI-native Supabase infrastructure management MCP Server.
 * Supports multi-tenant project access with project scoping and read-only mode.
 *
 * Usage (Claude Desktop / Cursor / Windsurf):
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
 *         "SUPACLOUD_API_TOKEN": "",
 *         "SUPACLOUD_PROJECT_REF": "",
 *         "SUPACLOUD_READ_ONLY": "false"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Environment variables:
 * - SUPACLOUD_HOST:         Target server IP / domain (required)
 * - SUPACLOUD_SSH_USER:     SSH username (default root)
 * - SUPACLOUD_SSH_PORT:     SSH port (default 22)
 * - SUPACLOUD_SSH_KEY:      SSH private key path (default ~/.ssh/id_rsa)
 * - SUPACLOUD_SSH_PASS:     SSH password (prefer key)
 * - SUPACLOUD_API_URL:      Management API URL (default http://{HOST}:9090)
 * - SUPACLOUD_API_TOKEN:    Management API Master Token (fill in after installation)
 * - SUPACLOUD_PROJECT_REF:  Scope to specific project (optional, enables project-scoped mode)
 * - SUPACLOUD_READ_ONLY:    Enable read-only mode (optional, default false)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SshTransport } from "./transports/ssh";
import { HttpTransport } from "./transports/http";
import { registerSshTools } from "./tools/ssh-tools";
import { registerProjectTools } from "./tools/project-tools";
import { registerAdvancedTools } from "./tools/advanced-tools";
import { registerDeploymentTools } from "./tools/deployment-tools";
import { registerDatabaseTools } from "./tools/database-tools";
import { registerAuthTools } from "./tools/auth-tools";
import { registerStorageTools } from "./tools/storage-tools";
import { registerOrganizationTools } from "./tools/org-tools";
import { registerTaskTools } from "./tools/task-tools";
import { resolve } from "path";
import { homedir } from "os";

// ── Parse environment variables ──
const HOST = process.env.SUPACLOUD_HOST ?? "";
const SSH_USER = process.env.SUPACLOUD_SSH_USER ?? "root";
const SSH_PORT = parseInt(process.env.SUPACLOUD_SSH_PORT ?? "22", 10);
const SSH_KEY = process.env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa");
const SSH_PASS = process.env.SUPACLOUD_SSH_PASS ?? "";
const API_URL = process.env.SUPACLOUD_API_URL ?? (HOST ? `http://${HOST}:9090` : "");
const API_TOKEN = process.env.SUPACLOUD_API_TOKEN ?? "";
const PROJECT_REF = process.env.SUPACLOUD_PROJECT_REF ?? "";
const READ_ONLY = process.env.SUPACLOUD_READ_ONLY === "true";

// ── Create MCP Server ──
const serverName = PROJECT_REF ? `supacloud-${PROJECT_REF}` : "supacloud";
const server = new McpServer({
    name: serverName,
    version: "0.5.5",
});

// ── Register SSH tools (always available) ──
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

// ── Register HTTP tools (requires API URL) ──
if (API_URL) {
    const http = new HttpTransport({
        baseUrl: API_URL,
        token: API_TOKEN,
    });

    // Database tools with project scoping and read-only mode
    registerDatabaseTools(server, http, {
        projectRef: PROJECT_REF || undefined,
        readOnly: READ_ONLY,
    });

    // Auth provider management tools
    registerAuthTools(server, http);

    // Storage management tools
    registerStorageTools(server, http);

    // Task queue monitoring tools
    registerTaskTools(server, http);

    // Project management tools (only if not project-scoped)
    if (!PROJECT_REF) {
        registerProjectTools(server, http);
        // Organization management tools
        registerOrganizationTools(server, http);
    }

    // Advanced tools (skip write operations in read-only mode)
    registerAdvancedTools(server, http);
}

// ── Register deployment tools (local Docker operations) ──
registerDeploymentTools(server);

// ── If neither is configured, register a help tool ──
if (!HOST && !API_URL) {
    server.tool(
        "setup_help",
        "Display SupaCloud MCP Server configuration guide",
        {},
        async () => ({
            content: [
                {
                    type: "text",
                    text: [
                        "⚠️ SupaCloud MCP Server target server not configured.",
                        "",
                        "Please set the following environment variables in MCP config:",
                        "",
                        "  SUPACLOUD_HOST         - Server IP or domain (required)",
                        "  SUPACLOUD_SSH_USER     - SSH username (default root)",
                        "  SUPACLOUD_SSH_KEY      - SSH private key path (default ~/.ssh/id_rsa)",
                        "  SUPACLOUD_API_URL      - Management API URL (auto-inferred after installation)",
                        "  SUPACLOUD_API_TOKEN    - Master Token (fill in after installation)",
                        "  SUPACLOUD_PROJECT_REF  - Scope to specific project (optional)",
                        "  SUPACLOUD_READ_ONLY    - Enable read-only mode (optional, default false)",
                        "",
                        "Configuration example (claude_desktop_config.json):",
                        JSON.stringify(
                            {
                                mcpServers: {
                                    supacloud: {
                                        command: "npx",
                                        args: ["-y", "@supacloud/mcp-server"],
                                        env: {
                                            SUPACLOUD_HOST: "YOUR_SERVER_IP",
                                            SUPACLOUD_SSH_KEY: "~/.ssh/id_rsa",
                                            SUPACLOUD_API_TOKEN: "your-master-token",
                                        },
                                    },
                                },
                            },
                            null,
                            2
                        ),
                        "",
                        "Project-scoped mode (single project access):",
                        JSON.stringify(
                            {
                                mcpServers: {
                                    "supacloud-myproject": {
                                        command: "npx",
                                        args: ["-y", "@supacloud/mcp-server"],
                                        env: {
                                            SUPACLOUD_HOST: "YOUR_SERVER_IP",
                                            SUPACLOUD_API_TOKEN: "your-master-token",
                                            SUPACLOUD_PROJECT_REF: "abc123defg",
                                            SUPACLOUD_READ_ONLY: "true",
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

// ── Start stdio transport ──
async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("SupaCloud MCP Server failed to start:", err);
    process.exit(1);
});
