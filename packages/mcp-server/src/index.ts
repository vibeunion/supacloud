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
import { registerDocsResources } from "./resources/docs";
import { resolve } from "path";
import { homedir } from "os";

const { readFileSync, existsSync } = require("fs");
const { resolve: pathResolve } = require("path");

// ── Auto-detect .env logic for Thick Client ──
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

// ── Parse environment variables ──
const HOST = process.env.SUPACLOUD_HOST ?? (tempUrl ? new URL(tempUrl).hostname : "");
const SSH_USER = process.env.SUPACLOUD_SSH_USER ?? "root";
const SSH_PORT = parseInt(process.env.SUPACLOUD_SSH_PORT ?? "22", 10);
const SSH_KEY = process.env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa");
const SSH_PASS = process.env.SUPACLOUD_SSH_PASS ?? "";

// For tenant setups, API_URL maps directly to the project domain gateway.
// Note: Management API runs on port 9090 natively, but tenant APIs proxy via standard HTTP/HTTPS.
let API_URL = process.env.SUPACLOUD_API_URL ?? (tempUrl ? tempUrl.replace(/\/+$/, "") : (HOST ? `http://${HOST}:9090` : ""));
if (API_URL && !API_URL.includes(":9090") && !API_URL.endsWith("/mcp")) {
    API_URL = `${API_URL}/mcp`;
}
const API_TOKEN = process.env.SUPACLOUD_API_TOKEN ?? tempKey ?? "";
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
        "generate_auth_system",
        "Generate authentication triggers and profile sync logic",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to build an Auth system for project '${args.ref}'. First, read the resource 'docs://supabase/auth' to understand current platform best practices. Then, help me execute the precise SQL to create a public.profiles table and a 'on_auth_user_created' trigger.`
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
                        text: `I want to design a database schema for a '${args.domain}' workload on Supabase. I am working on project '${args.ref}'. Please start by reading the resource 'docs://supabase/sql' to ensure modern RLS practices are fresh in your memory. Then, propose the SQL for new tables, ensuring every table has ROW LEVEL SECURITY enabled, uses UUID primary keys, and has an 'updated_at' trigger. Whenever you actually create tables, prefer using the 'create_table_with_rls' tool.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "design_and_save_migration",
        "Design a schema migration and save it as a local SQL file before applying",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to create a database migration for project '${args.ref}'. Please interactively ask me what schema changes I need. Once we agree on the SQL, DO NOT immediately apply it. First, use your native IDE capabilities to create and save the SQL text into a file at 'supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql' in the local workspace. After successfully saving the local file, ask me if I want to execute it against the cloud database.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "update_typescript_types",
        "Generate TypeScript definitions and save them to the local workspace",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to update the TypeScript definitions for project '${args.ref}'. Please use the 'generate_typescript_types' tool. Instead of just showing me the output, use your native IDE capabilities to overwrite the file at 'types/supabase.ts' in my local workspace with the generated types.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "analyze_slow_queries",
        "Fetch and analyze slow performing queries",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please analyze the slow queries for project '${args.ref}'. Use the 'get_slow_queries' tool to fetch the top 10 most expensive queries. Review their shapes, identify missing indexes, write out the 'CREATE INDEX CONCURRENTLY' statements, and ask me if I want to execute them via the 'execute_sql' tool.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "generate_mock_data",
        "Generate realistic mock data and save local seed script",
        {
            ref: z.string().describe("Project ref to work on"),
            table: z.string().describe("Table to seed (Optionally 'all')"),
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to seed mock data for project '${args.ref}' targeting table '${args.table}'. First, introspect the schema and constraints of the table(s). Then, draft highly realistic batch 'INSERT' SQL statements containing diverse, simulated data spanning at least 20 rows. Save this output to 'supabase/seed.sql' in the local workspace workspace using IDE file tools. Finally, ask if I want you to run the SQL remotely.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "run_security_audit",
        "Run a comprehensive security audit on the project database",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Run a security audit for project '${args.ref}'. Use 'get_rls_status' and 'list_table_policies' to ensure public tables are protected. Look for functions with SECURITY DEFINER lacking safe search paths. Once you analyze everything, use your IDE tools to write a detailed markdown report locally to 'SupaCloud_Security_Audit.md'.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "sync_local_edge_functions",
        "Deploy local Edge Functions to the Cloud",
        {
            ref: z.string().describe("Project ref to work on"),
            function_name: z.string().describe("Name of the folder inside supabase/functions/ to deploy"),
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I want to deploy the Edge Function '${args.function_name}' for project '${args.ref}'. Please use your native IDE capabilities to read all the code from 'supabase/functions/${args.function_name}/index.ts' and any dependencies. Consolidate them into a unified code string, and use the 'deploy_edge_function' tool to deploy it to the cloud. Output the success status when done.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "setup_scheduled_job",
        "Create a pg_cron scheduled background job",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I need to set up a scheduled background job for project '${args.ref}'. Please use pg_cron syntax (e.g., SELECT cron.schedule('job_name', '0 0 * * *', 'SQL_COMMAND')). Interactively work with me to define the schedule and the target SQL, ensure the pg_cron extension is active via 'list_extensions', and finally execute it via 'execute_sql'.`
                    }
                }
            ]
        })
    );

    server.prompt(
        "check_schema_diff",
        "Compare local migration files against the remote database schema",
        {
            ref: z.string().describe("Project ref to work on")
        },
        (args: any) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `I want to check what schema changes are pending for project '${args.ref}'. First, use IDE tools to read the local SQL files inside 'supabase/migrations/'. Next, query the remote database schema using 'list_tables' and 'list_table_columns_by_schema'. Compare the two states and output a concise Markdown report detailing any missing tables, altered columns, or pending migrations.`
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

// ── Register Documents (Resources) ──
registerDocsResources(server);

// ── Start stdio transport ──
async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("SupaCloud MCP Server failed to start:", err);
    process.exit(1);
});
