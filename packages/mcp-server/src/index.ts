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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

// ── Proxy / Local Mode ──
if (process.argv.includes("--local") || process.argv.includes("--proxy")) {
    const { readFileSync, existsSync } = require("fs");
    const { resolve: pathResolve } = require("path");
    
    // Auto-detect .env logic
    let tempUrl = process.env.SUPABASE_URL || process.env.SUPACLOUD_API_URL || "";
    let tempKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPACLOUD_API_TOKEN || "";
    
    const envPath = pathResolve(process.cwd(), ".env");
    if ((!tempUrl || !tempKey) && existsSync(envPath)) {
        try {
            const envContent = readFileSync(envPath, "utf-8");
            for (const line of envContent.split("\n")) {
                const match = line.trim().match(/^([^=]+)=(.*)$/);
                if (match) {
                    const k = match[1].trim();
                    const v = match[2].trim().replace(/^["']|["']$/g, "");
                    if ((k === "SUPABASE_URL" || k === "SUPACLOUD_API_URL") && !tempUrl) tempUrl = v;
                    if ((k === "SUPABASE_SERVICE_ROLE_KEY" || k === "SUPACLOUD_API_TOKEN") && !tempKey) tempKey = v;
                }
            }
        } catch { /* ignore */ }
    }

    if (!tempUrl || !tempKey) {
        process.stderr.write("❌ Proxy Mode Error: Could not find SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment or local .env file\\n");
        process.exit(1);
    }
    
    const EventSource = require("eventsource");
    (global as any).EventSource = EventSource;
    
    const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
    const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

    const mcpUrl = tempUrl.replace(/\/+$/, "") + "/mcp";

    async function runProxy() {
        const client = new SSEClientTransport(new URL(mcpUrl), {
            headers: { "Authorization": `Bearer ${tempKey}` }
        });
        
        const server = new StdioServerTransport();
        
        client.onmessage = (msg: any) => server.send(msg);
        server.onmessage = (msg: any) => client.send(msg);
        
        // Handle closure gracefully to prevent stderr noise in IDE
        client.onclose = () => process.exit(0);
        client.onerror = (err: any) => {
            process.stderr.write(`[Proxy Error] ${err}\\n`);
            process.exit(1);
        };
        server.onclose = () => {
            client.close();
            process.exit(0);
        };

        await server.start();
        await client.start();
    }
    
    runProxy().catch(e => {
        process.stderr.write(`Failed to start proxy: ${e}\\n`);
        process.exit(1);
    });

} else {

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

    // ── Register MCP Prompts ──
    server.prompt(
        "analyze_database_performance",
        "Analyze database performance (size, connections, slow queries)",
        {
            ref: z.string().describe("Project ref to analyze")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please analyze the database performance for project '${args.ref}'. Start by using 'get_database_stats' and 'get_database_connections' to gather metrics, then provide recommendations on missing indexes, connection bloat, or table sizing optimization.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "design_tenant_schema",
        "Help design a database schema following best practices and RLS",
        {
            ref: z.string().describe("Project ref to work on"),
            domain: z.string().describe("Business domain to model (e.g., 'e-commerce store', 'SaaS platform')")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I want to design a database schema for a '${args.domain}' workload on Supabase. I am working on project '${args.ref}'. Please start by querying 'list_tables' to see what already exists. Then propose the SQL for new tables, ensuring every table has ROW LEVEL SECURITY enabled, uses UUID primary keys, and has an 'updated_at' trigger. Whenever you actually create tables, prefer using the 'create_table_with_rls' tool.`
                    }
                }
            ]
        })
    );

    // ── Register MCP Resources ──
    // Expose database schemas as real-time readable resources (e.g. pg://test/schema/public)
    server.resource(
        "database-schema",
        new ResourceTemplate("pg://{ref}/schema/{schema}", { list: undefined }),
        async (uri: any, { ref, schema }: { ref?: string; schema?: string }) => {
            if (typeof ref !== 'string' || typeof schema !== 'string') {
                throw new Error("Missing ref or schema in resource URI");
            }
            if (PROJECT_REF && PROJECT_REF !== ref) {
                throw new Error(`Unauthorized: Server is scoped to project ${PROJECT_REF}`);
            }
            
            const sqlCols = `
                SELECT table_name, column_name, data_type, is_nullable, column_default 
                FROM information_schema.columns 
                WHERE table_schema = '${schema.replace(/'/g, "''")}';
            `;
            const colRes = await http.post(`/v1/projects/${ref}/database/sql`, { sql: sqlCols });
            
            let markdown = `# Database Schema: ${schema}\\n\\n`;
            if (colRes.ok && typeof colRes.data === 'object' && colRes.data && 'rows' in colRes.data) {
                const cols = (colRes.data as { rows: any[] }).rows || [];
                const grouped: Record<string, any[]> = {};
                for (const c of cols) {
                    if (!grouped[c.table_name]) grouped[c.table_name] = [];
                    grouped[c.table_name].push(c);
                }
                
                for (const [tname, tcols] of Object.entries(grouped)) {
                    markdown += `## Table: \`${tname}\`\\n`;
                    for (const c of tcols) {
                        const nullFlag = c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
                        const defFlag = c.column_default ? ` DEFAULT ${c.column_default}` : '';
                        markdown += `- \`${c.column_name}\`: \`${c.data_type}\` ${nullFlag}${defFlag}\\n`;
                    }
                    markdown += `\\n`;
                }
                if (Object.keys(grouped).length === 0) {
                     markdown += `*No tables found in schema '${schema}'.*`;
                }
            } else {
                markdown += `*Error or no tables found: ${JSON.stringify(colRes.data)}*`;
            }

            return {
                contents: [
                    {
                        uri: uri.href,
                        text: markdown,
                        mimeType: "text/markdown"
                    }
                ]
            };
        }
    );

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
}
