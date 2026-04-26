#!/usr/bin/env node

import { z } from "zod";
import { runCli } from "./shared/cli";
import { resolveSupaCloudContext } from "./shared/context";
import { HttpTransport } from "./shared/transports/http";
import { registerDatabaseTools } from "./shared/tools/database-tools";
import { registerAuthTools } from "./shared/tools/auth-tools";
import { registerStorageTools } from "./shared/tools/storage-tools";
import { registerAdvancedTools } from "./shared/tools/advanced-tools";
import { registerFrontendTools } from "./shared/tools/frontend-tools";
import { registerUserProjectCliTools } from "./shared/tools/project-cli-tools";

type ToolEntry = { schema: any; callback: (args: any) => Promise<any> };
type ToolMap = Record<string, ToolEntry>;

const projectActionSchema = z.enum(["get", "health", "logs", "api_keys", "settings", "tasks"]);
const genericActionSchema = z.string();

function unwrapMcpSchema(schema: any): any {
    if (schema && typeof schema === "object" && !Array.isArray(schema) && "args" in schema) {
        const argsSchema = schema.args;
        if (argsSchema && typeof argsSchema === "object" && !Array.isArray(argsSchema)) {
            return argsSchema;
        }
    }
    return schema;
}

function captureTools(register: (server: { tool: (...args: any[]) => void }) => void): ToolMap {
    const tools: ToolMap = {};
    const server = {
        tool(name: string, _description: string, schemaOrCallback: any, callback?: any) {
            if (typeof schemaOrCallback === "function") {
                tools[name] = { schema: {}, callback: schemaOrCallback };
            } else {
                tools[name] = { schema: unwrapMcpSchema(schemaOrCallback), callback };
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
  supacloud project logs --log_type database
  supacloud frontend list --ref abc123
  supacloud database query --sql "select now()"
  supacloud edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello
  supacloud edge_functions config --ref abc123 --slug hello --verify_jwt false --background_routes "/queue/*,/render/*"

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

    const registerContextAwareHelp = () => {
        tools.project = {
            schema: { action: projectActionSchema },
            callback: async () => ({
                content: [
                    {
                        type: "text" as const,
                        text: [
                            "⚠️ Project commands need a project-scoped API context.",
                            "",
                            "Provide one of these sources:",
                            "  - .env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
                            "  - SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN",
                            "",
                            "Then retry commands such as:",
                            "  supacloud project get",
                            "  supacloud project logs --log_type database",
                        ].join("\n"),
                    },
                ],
            }),
        };
        for (const name of ["database", "auth", "storage", "edge_functions", "secrets", "frontend"]) {
            tools[name] = {
                schema: { action: genericActionSchema },
                callback: async () => ({
                    content: [
                        {
                            type: "text" as const,
                            text: "⚠️ This command requires project-scoped API context. Run `supacloud status` to inspect current detection.",
                        },
                    ],
                }),
            };
        }
    };

    if (!context.apiUrl || !context.apiToken) {
        registerContextAwareHelp();
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

    assign(captureTools((server) => registerUserProjectCliTools(server as any, http, {
        projectRef: context.projectRef || undefined,
    })));
    const databaseTools = captureTools((server) => registerDatabaseTools(server as any, http, {
        projectRef: context.projectRef || undefined,
        readOnly: context.readOnly,
    }));
    assign(databaseTools);
    assign(captureTools((server) => registerAuthTools(server as any, http)));
    assign(captureTools((server) => registerStorageTools(server as any, http)));
    assign(captureTools((server) => registerAdvancedTools(server as any, http)));
    assign(captureTools((server) => registerFrontendTools(server as any, http)));

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
