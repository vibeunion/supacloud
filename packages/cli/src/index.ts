#!/usr/bin/env node

import { runCli } from "../../mcp-server/src/cli";
import { resolveSupaCloudContext } from "../../mcp-server/src/context";
import { HttpTransport } from "../../mcp-server/src/transports/http";
import { registerDatabaseTools } from "../../mcp-server/src/tools/database-tools";
import { registerAuthTools } from "../../mcp-server/src/tools/auth-tools";
import { registerStorageTools } from "../../mcp-server/src/tools/storage-tools";
import { registerAdvancedTools } from "../../mcp-server/src/tools/advanced-tools";
import { registerFrontendTools } from "../../mcp-server/src/tools/frontend-tools";
import { registerProjectTools } from "../../mcp-server/src/tools/project-tools";

type ToolEntry = { schema: any; callback: (args: any) => Promise<any> };
type ToolMap = Record<string, ToolEntry>;

function captureTools(register: (server: { tool: (...args: any[]) => void }) => void): ToolMap {
    const tools: ToolMap = {};
    const server = {
        tool(name: string, _description: string, schemaOrCallback: any, callback?: any) {
            if (typeof schemaOrCallback === "function") {
                tools[name] = { schema: {}, callback: schemaOrCallback };
            } else {
                tools[name] = { schema: schemaOrCallback, callback };
            }
        },
    };
    register(server);
    return tools;
}

function printHelp(context = resolveSupaCloudContext()) {
    const autoLink = context.inferredSupabaseUrl
        ? `Project context: ${context.inferredSupabaseUrl} (${context.source})`
        : "Project context: not detected";

    console.error(`
╔═══════════════════════════════════════════════════════════╗
║  supacloud                                               ║
║  Project CLI for SupaCloud users                         ║
╚═══════════════════════════════════════════════════════════╝

USAGE

  supacloud <module> <action> [--flags]
  supacloud status
  supacloud --help

DEFAULT CONTEXT

  Unauthenticated runs default to the current project's .env.
  Supported auto-link variables:
    SUPABASE_URL / SUPACLOUD_API_URL
    SUPABASE_SERVICE_ROLE_KEY / SUPACLOUD_API_TOKEN

  ${autoLink}

EXAMPLES

  supacloud status
  supacloud project get
  supacloud frontend list --ref abc123
  supacloud database query --sql "select now()"
  supacloud edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello

SEPARATE ADMIN CLI

  Server installation, SSH diagnostics, tenant runtime operations, and
  platform-wide administration live in:

    npx @supacloud/admin --help
`);
}

function createCliTools(): ToolMap {
    const context = resolveSupaCloudContext();
    const tools: ToolMap = {
        status: {
            schema: {},
            callback: async () => ({
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                mode: "project",
                                source: context.source,
                                projectRef: context.projectRef || null,
                                apiUrl: context.apiUrl || null,
                                autoLinked: Boolean(context.inferredSupabaseUrl && context.inferredServiceRoleKey),
                                hasApiToken: Boolean(context.apiToken),
                            },
                            null,
                            2,
                        ),
                    },
                ],
            }),
        },
    };

    if (!context.apiUrl || !context.apiToken) {
        tools.setup_help = {
            schema: {},
            callback: async () => ({
                content: [
                    {
                        type: "text" as const,
                        text: [
                            "⚠️ No project context found for supacloud.",
                            "",
                            "supacloud expects project-scoped credentials by default.",
                            "Provide one of these sources:",
                            "",
                            "  1. Current workspace .env",
                            "     SUPABASE_URL=https://your-project.example.com",
                            "     SUPABASE_SERVICE_ROLE_KEY=...",
                            "",
                            "  2. Explicit environment variables",
                            "     SUPACLOUD_API_URL=https://your-project.example.com",
                            "     SUPACLOUD_API_TOKEN=...",
                            "",
                            "For server installation and tenant management, use:",
                            "  supacloud-admin",
                        ].join("\n"),
                    },
                ],
            }),
        };
        return tools;
    }

    const http = new HttpTransport({
        baseUrl: context.apiUrl,
        token: context.apiToken,
    });

    const assign = (extra: ToolMap) => Object.assign(tools, extra);

    assign(captureTools((server) => registerDatabaseTools(server as any, http, {
        projectRef: context.projectRef || undefined,
        readOnly: context.readOnly,
    })));
    assign(captureTools((server) => registerAuthTools(server as any, http)));
    assign(captureTools((server) => registerStorageTools(server as any, http)));
    assign(captureTools((server) => registerAdvancedTools(server as any, http)));
    assign(captureTools((server) => registerFrontendTools(server as any, http)));

    if (!context.projectRef) {
        assign(captureTools((server) => registerProjectTools(server as any, http)));
    }

    delete tools.platform;
    return tools;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp();
        process.exit(0);
    }

    const cliTools = createCliTools();
    if (args.length === 1 && cliTools[args[0]]) {
        const result = await cliTools[args[0]].callback({});
        if (result?.content && Array.isArray(result.content)) {
            for (const chunk of result.content) {
                if (chunk.type === "text") {
                    console.log(chunk.text);
                }
            }
            return;
        }
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    await runCli(cliTools, args, { commandName: "supacloud" });
}

main().catch((error) => {
    console.error("supacloud failed:", error);
    process.exit(1);
});
