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
import { registerFrontendTools } from "./tools/frontend-tools";
import { registerDocsResources } from "./resources/docs";
import { resolve } from "path";
import { homedir } from "os";

const { readFileSync, existsSync } = require("fs");
const { resolve: pathResolve } = require("path");

// ── --help flag ──
if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const pkg = require("../package.json");
    process.stderr.write(`
  ╔═══════════════════════════════════════════════════════════╗
  ║  supacloud-mcp  v${pkg.version.padEnd(40)}║
  ║  AI-native Supabase infrastructure management            ║
  ╚═══════════════════════════════════════════════════════════╝

  USAGE

    npx supacloud-mcp                    Start as stdio MCP server
    npx supacloud-mcp --help             Show this help
    npx supacloud-mcp <module> <action>  Run a specific tool from the CLI

  CLI EXAMPLES

    npx supacloud-mcp project list
    npx supacloud-mcp database query --ref abc123 --sql "SELECT 1"
    npx supacloud-mcp ssh diagnose
    npx supacloud-mcp edge_functions deploy --ref abc123 --slug hello --code "..."

  CONFIGURATION

    Mode 1 — Remote MCP Endpoint (recommended)
    ─────────────────────────────────────────────
    No local install needed. Add to your IDE's MCP config:

      {
        "mcpServers": {
          "supacloud": {
            "url": "http://your-server:9090/mcp",
            "headers": { "Authorization": "Bearer <master-token>" }
          }
        }
      }

    Mode 2 — Local stdio (with SSH tools)
    ─────────────────────────────────────────────
      {
        "mcpServers": {
          "supacloud": {
            "command": "npx",
            "args": ["-y", "supacloud-mcp"],
            "env": {
              "SUPACLOUD_HOST": "1.2.3.4",
              "SUPACLOUD_SSH_KEY": "~/.ssh/id_rsa",
              "SUPACLOUD_API_TOKEN": "<master-token>"
            }
          }
        }
      }

    Mode 3 — Project-scoped (read-only for developers)
    ─────────────────────────────────────────────
      {
        "mcpServers": {
          "my-project": {
            "command": "npx",
            "args": ["-y", "supacloud-mcp"],
            "env": {
              "SUPACLOUD_API_URL": "http://your-server:9090",
              "SUPACLOUD_API_TOKEN": "<project-token>",
              "SUPACLOUD_PROJECT_REF": "abc123",
              "SUPACLOUD_READ_ONLY": "true"
            }
          }
        }
      }

  ENVIRONMENT VARIABLES

    SUPACLOUD_HOST           Server IP / domain (required for SSH mode)
    SUPACLOUD_SSH_USER       SSH user (default: root)
    SUPACLOUD_SSH_PORT       SSH port (default: 22)
    SUPACLOUD_SSH_KEY        SSH private key path (default: ~/.ssh/id_rsa)
    SUPACLOUD_SSH_PASS       SSH password (alternative to key)
    SUPACLOUD_API_URL        Management API URL (default: http://{HOST}:9090)
    SUPACLOUD_API_TOKEN      Master Token or Project Token
    SUPACLOUD_PROJECT_REF    Scope to a specific project
    SUPACLOUD_READ_ONLY      Enable read-only mode (default: false)

  FEATURES

    ~12 compound tools covering:
    • Project lifecycle    — create, configure, pause, delete
    • Database             — SQL queries, schema, RLS, migrations
    • Auth                 — OAuth providers (GitHub/Google/WeChat/etc.)
    • Storage              — S3/MinIO buckets, file operations
    • Edge Functions       — deploy, manage, server-side bundling
    • Frontend Hosting     — static sites, SSR, Git deploy, custom domains
    • Secrets              — environment variables for Edge Functions
    • Monitoring           — system metrics, task queues, backups

  DOCS

    https://github.com/zuohuadong/supacloud

`);
    process.exit(0);
}


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
const API_TOKEN = process.env.SUPACLOUD_API_TOKEN ?? tempKey ?? "";
const PROJECT_REF = process.env.SUPACLOUD_PROJECT_REF ?? "";
const READ_ONLY = process.env.SUPACLOUD_READ_ONLY === "true";

// ── Create MCP Server ──
const serverName = PROJECT_REF ? `supacloud-${PROJECT_REF}` : "supacloud";
const server = new McpServer({
    name: serverName,
    version: "0.5.5",
});

// Proxy tool registration to build CLI mapping
export const cliTools: Record<string, { schema: any; callback: (args: any) => Promise<any> }> = {};
const originalTool = server.tool.bind(server);
(server as any).tool = (name: string, description: string, schemaOrCb: any, callback?: any) => {
    if (typeof schemaOrCb === "function") {
        cliTools[name] = { schema: {}, callback: schemaOrCb };
    } else {
        cliTools[name] = { schema: schemaOrCb, callback };
    }
    return originalTool(name, description, schemaOrCb, callback);
};

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
                        text: `Please analyze the database performance for project '${args.ref}'. Use the 'database' tool with action='stats' and action='connections' to gather metrics, then provide recommendations on missing indexes, connection bloat, or table sizing optimization.`
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
                        text: `I want to design a database schema for a '${args.domain}' workload on Supabase. I am working on project '${args.ref}'. Please start by reading the resource 'docs://supabase/sql' to ensure modern RLS practices are fresh in your memory. Then, propose the SQL for new tables, ensuring every table has ROW LEVEL SECURITY enabled, uses UUID primary keys, and has an 'updated_at' trigger. Whenever you actually create tables, use the 'database' tool with action='create_table_rls'.`
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
                        text: `I need to update the TypeScript definitions for project '${args.ref}'. Please use the 'database' tool with action='generate_types'. Instead of just showing me the output, use your native IDE capabilities to overwrite the file at 'types/supabase.ts' in my local workspace with the generated types.`
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
                        text: `Please analyze the slow queries for project '${args.ref}'. Use the 'database' tool with action='slow_queries' to fetch the top 10 most expensive queries. Review their shapes, identify missing indexes, write out the 'CREATE INDEX CONCURRENTLY' statements, and ask me if I want to execute them via the 'database' tool with action='query'.`
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
                        text: `Run a security audit for project '${args.ref}'. Use the 'database' tool with action='rls_status' and action='rls_policies' to ensure public tables are protected. Look for functions with SECURITY DEFINER lacking safe search paths. Once you analyze everything, use your IDE tools to write a detailed markdown report locally to 'SupaCloud_Security_Audit.md'.`
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
                        text: `I want to deploy the Edge Function '${args.function_name}' for project '${args.ref}'. Please use your native IDE capabilities to read all the code from 'supabase/functions/${args.function_name}/index.ts' and any dependencies. Consolidate them into a unified code string, and use the 'edge_functions' tool with action='deploy' to deploy it to the cloud.`
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
                        text: `I need to set up a scheduled background job for project '${args.ref}'. Please use pg_cron syntax (e.g., SELECT cron.schedule('job_name', '0 0 * * *', 'SQL_COMMAND')). Interactively work with me to define the schedule and the target SQL, ensure the pg_cron extension is active via 'database' action='list_extensions', and finally execute it via 'database' action='query'.`
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
                        text: `I want to check what schema changes are pending for project '${args.ref}'. First, use IDE tools to read the local SQL files inside 'supabase/migrations/'. Next, query the remote database schema using 'database' tool with action='list_tables' and action='describe_columns'. Compare the two states and output a concise Markdown report.`
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

    // Auth tools (compound)
    registerAuthTools(server, http);

    // Storage tools (compound)
    registerStorageTools(server, http);

    // Project management tools (compound, includes tasks; only if not project-scoped)
    if (!PROJECT_REF) {
        registerProjectTools(server, http);
    }

    // Advanced tools: edge_functions + secrets + platform (includes org, backups, monitoring)
    registerAdvancedTools(server, http);

    // Frontend hosting (compound)
    registerFrontendTools(server, http);
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

// ── Start Server or CLI ──
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length > 0 && args[0] !== "--stdio" && args[0] !== "--help" && args[0] !== "-h") {
        const { runCli } = await import("./cli");
        await runCli(cliTools, args);
    } else {
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

main().catch((err) => {
    console.error("SupaCloud MCP / CLI failed to start:", err);
    process.exit(1);
});
