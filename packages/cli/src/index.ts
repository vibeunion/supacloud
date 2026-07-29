#!/usr/bin/env node

import { Type } from "@sinclair/typebox";
import { stringEnum } from "./shared/schema";
import { cliToolResultIsError, runCli } from "./shared/cli";
import { resolveSupaCloudContext, type ResolvedContext } from "./shared/context";
import { HttpTransport } from "./shared/transports/http";
import { registerDatabaseTools } from "./shared/tools/database-tools";
import { registerAuthTools } from "./shared/tools/auth-tools";
import { registerStorageTools } from "./shared/tools/storage-tools";
import { registerAdvancedTools } from "./shared/tools/advanced-tools";
import { registerFrontendTools } from "./shared/tools/frontend-tools";
import { registerUserProjectCliTools } from "./shared/tools/project-cli-tools";
import { registerQueueTools } from "./shared/tools/queue-tools";
import { registerGatewayTools } from "./shared/tools/gateway-tools";
import { registerBranchTools } from "./shared/tools/branch-tools";
import { registerSupabaseCliTools } from "./shared/tools/supabase-cli-tools";
import { registerAiTools } from "./shared/tools/ai-tools";

type ToolEntry = { schema: any; callback: (args: any) => Promise<any> };
type ToolMap = Record<string, ToolEntry>;

const commandName = "supacloud-cli";
const preferredCommand = commandName;
const projectActionSchema = stringEnum([
    "get", "health", "logs", "api_keys", "settings",
    "tasks", "task_detail", "task_cancel", "task_retry", "task_stats", "dlq", "background_settings", "update_background_settings",
]);
const genericActionSchema = Type.String();

interface EndpointProbe {
    reachable: boolean;
    ok: boolean;
    httpStatus: number | null;
    error: string | null;
}

interface ProjectStatusChecks {
    configuration: { ok: boolean; missing: string[] };
    connectivity: { ok: boolean | null; reachable: boolean | null; httpStatus: number | null; error: string | null };
    authentication: { ok: boolean | null; httpStatus: number | null };
    project: { ok: boolean | null };
}

function successfulEndpointProbe(response: Response): EndpointProbe {
    return { reachable: true, ok: response.ok, httpStatus: response.status, error: null };
}

function failedEndpointProbe(error: unknown): EndpointProbe {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { reachable: false, ok: false, httpStatus: null, error: timedOut ? "timeout" : "unreachable" };
}

async function probeEndpoint(url: string, token?: string): Promise<EndpointProbe> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal: controller.signal,
        });
        return successfulEndpointProbe(response);
    } catch (error) {
        return failedEndpointProbe(error);
    } finally {
        clearTimeout(timeout);
    }
}

function missingProjectContextFields(context: ResolvedContext): string[] {
    return [
        !context.apiUrl ? "apiUrl" : null,
        !context.apiToken ? "apiToken" : null,
        !context.projectRef ? "projectRef" : null,
    ].filter((field): field is string => Boolean(field));
}

function authenticatedByProbe(authentication: EndpointProbe | null): boolean | null {
    if (!authentication) return null;
    return authentication.reachable && ![401, 403].includes(authentication.httpStatus ?? 0);
}

async function collectProjectStatusChecks(context: ResolvedContext): Promise<ProjectStatusChecks> {
    const missing = missingProjectContextFields(context);
    const connectivity = context.apiUrl ? await probeEndpoint(`${context.apiUrl}/health`) : null;
    const authentication = missing.length === 0 && connectivity?.ok
        ? await probeEndpoint(`${context.apiUrl}/v1/projects/${encodeURIComponent(context.projectRef)}/health`, context.apiToken)
        : null;
    return {
        configuration: { ok: missing.length === 0, missing },
        connectivity: {
            ok: connectivity?.ok ?? null,
            reachable: connectivity?.reachable ?? null,
            httpStatus: connectivity?.httpStatus ?? null,
            error: connectivity?.error ?? null,
        },
        authentication: { ok: authenticatedByProbe(authentication), httpStatus: authentication?.httpStatus ?? null },
        project: { ok: authentication?.ok ?? null },
    };
}

function projectStatusIsHealthy(checks: ProjectStatusChecks): boolean {
    return checks.configuration.ok
        && checks.connectivity.ok === true
        && checks.authentication.ok === true
        && checks.project.ok === true;
}

async function createProjectStatusResult(context: ResolvedContext) {
    const checks = await collectProjectStatusChecks(context);
    const statusPayload = {
        mode: "project",
        source: context.source,
        projectRef: context.projectRef || null,
        apiUrl: context.apiUrl || null,
        autoLinked: Boolean(context.inferredSupabaseUrl && context.inferredServiceRoleKey),
        hasApiToken: Boolean(context.apiToken),
        checks,
    };
    return {
        isError: !projectStatusIsHealthy(checks),
        content: [{ type: "text" as const, text: JSON.stringify(statusPayload, null, 2) }],
    };
}

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
║  supacloud-cli                                           ║
║  Project CLI for SupaCloud users                         ║
╚═══════════════════════════════════════════════════════════╝

USAGE

  ${preferredCommand} <module> <action> [--flags]
  ${preferredCommand} status
  ${preferredCommand} --help

DEFAULT CONTEXT

  Unauthenticated runs default to the current project's .env.
  Supported auto-link variables:
    SUPABASE_URL / SUPACLOUD_API_URL
    SUPABASE_SERVICE_ROLE_KEY / SUPACLOUD_API_TOKEN
    SUPACLOUD_PROJECT_REF (when it cannot be inferred from <ref>.api.*)

  status checks configuration, Management API connectivity, and authentication.
  It exits non-zero when a required check fails.

  ${autoLink}

EXAMPLES

  ${preferredCommand} status
  ${preferredCommand} project get
  ${preferredCommand} project logs --log_type database
  ${preferredCommand} project task_stats
  ${preferredCommand} queue stats --queue emails
  ${preferredCommand} queue dlq --queue emails --limit 20
  ${preferredCommand} frontend list --ref abc123
  ${preferredCommand} database query --sql "select now()"
  ${preferredCommand} database query --ref abc123 --file ./queries/vector-search.sql
  ${preferredCommand} database push_migrations --ref abc123 --dir supabase/migrations --dry_run
  ${preferredCommand} supabase migration_new --name add_accounts
  ${preferredCommand} supabase db_diff --schema public --name add_accounts
  ${preferredCommand} supabase push --ref abc123 --dir supabase/migrations --dry_run
  ${preferredCommand} supabase db_dump --db_url "postgresql://..." --file backups/schema.sql
  ${preferredCommand} branch create --name feature-auth --data_mode schema_only
  ${preferredCommand} branch promotion_plan --branch_ref preview123
  ${preferredCommand} branch promote --branch_ref preview123 --plan_checksum <sha256>
  ${preferredCommand} ai show_skill
  ${preferredCommand} ai install_skill --dry_run
  ${preferredCommand} edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello
  ${preferredCommand} edge_functions config --ref abc123 --slug hello --verify_jwt false --background_routes "/queue/*,/render/*"
  ${preferredCommand} gateway routes --ref abc123
  ${preferredCommand} gateway upsert_route --ref abc123 --route_id webhook --hosts "api.example.com" --paths "/webhook/*" --upstream 10.0.0.5:8080
  ${preferredCommand} gateway config --ref abc123 --rate_limit_tier pro
  ${preferredCommand} gateway rebuild --ref abc123 --clean

SEPARATE ADMIN CLI

  Server installation, SSH diagnostics, tenant runtime operations, and
  platform-wide administration live in:

    npx @supacloud/admin --help
`);
}

function createCliTools(): ToolMap {
    const context = resolveSupaCloudContext();
    let pushMigrations: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    const tools: ToolMap = {
        status: {
            schema: {},
            callback: async () => createProjectStatusResult(context),
        },
    };

    Object.assign(tools, captureTools((server) => registerSupabaseCliTools(server as any, {
        getPushMigrations: () => pushMigrations,
        projectRef: context.projectRef || undefined,
        readOnly: context.readOnly,
    })));
    Object.assign(tools, captureTools((server) => registerAiTools(server as any)));

    const registerContextAwareHelp = () => {
        tools.project = {
            schema: { action: projectActionSchema },
            callback: async () => ({
                isError: true,
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
                            `  ${preferredCommand} project get`,
                            `  ${preferredCommand} project logs --log_type database`,
                        ].join("\n"),
                    },
                ],
            }),
        };
        for (const name of ["database", "auth", "storage", "edge_functions", "secrets", "frontend", "queue", "task_events", "diagnostics", "gateway", "branch"]) {
            tools[name] = {
                schema: { action: genericActionSchema },
                callback: async () => ({
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: `⚠️ This command requires project-scoped API context. Run \`${preferredCommand} status\` to inspect current detection.`,
                        },
                    ],
                }),
            };
        }
        const branchContextCallback = tools.branch.callback;
        const branchHelpTool = captureTools((server) => registerBranchTools(server as any, {} as any, {
            readOnly: true,
        })).branch;
        if (branchHelpTool) {
            tools.branch = { schema: branchHelpTool.schema, callback: branchContextCallback };
        }
    };

    if (!context.apiUrl || !context.apiToken) {
        registerContextAwareHelp();
        tools.setup_help = {
            schema: {},
            callback: async () => ({
                isError: true,
                content: [
                    {
                        type: "text" as const,
                        text: [
                            `⚠️ No project context found for ${preferredCommand}.`,
                            "",
                            `${preferredCommand} expects project-scoped credentials by default.`,
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
    pushMigrations = databaseTools.database?.callback;
    assign(databaseTools);
    assign(captureTools((server) => registerAuthTools(server as any, http)));
    assign(captureTools((server) => registerStorageTools(server as any, http)));
    assign(captureTools((server) => registerAdvancedTools(server as any, http)));
    assign(captureTools((server) => registerFrontendTools(server as any, http)));
    assign(captureTools((server) => registerGatewayTools(server as any, http, {
        projectRef: context.projectRef || undefined,
    })));
    assign(captureTools((server) => registerBranchTools(server as any, http, {
        projectRef: context.projectRef || undefined,
        readOnly: context.readOnly,
    })));
    assign(captureTools((server) => registerQueueTools(server as any, http, {
        projectRef: context.projectRef || undefined,
    })));

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
    if (args.length === 1 && !["ai", "supabase"].includes(args[0]) && cliTools[args[0]]) {
        const result = await cliTools[args[0]].callback({});
        if (result?.content && Array.isArray(result.content)) {
            for (const chunk of result.content) {
                if (chunk.type === "text") {
                    console.log(chunk.text);
                }
            }
            if (cliToolResultIsError(result)) process.exitCode = 1;
            return;
        }
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    await runCli(cliTools, args, { commandName });
}

main().catch((error) => {
    console.error(`${commandName} failed:`, error);
    process.exit(1);
});
