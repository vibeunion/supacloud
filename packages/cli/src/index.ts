#!/usr/bin/env node

import { Type } from "@sinclair/typebox";
import { stringEnum } from "./shared/schema";
import { cliToolResultIsError, runCli } from "./shared/cli";
import {
    resolveSupaCloudContext,
    type ContextCredentialScope,
    type ResolvedContext,
} from "./shared/context";
import { parseGlobalOptions } from "./shared/global-options";
import { authorizeExecution, validateExecutionPolicyCoverage } from "./shared/execution-policy";
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
import { registerScheduledFunctionTools } from "./shared/tools/scheduled-function-tools";
import packageMetadata from "../package.json" with { type: "json" };

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

interface ProjectStatusProbePlan {
    apiUrl: string;
    connectivityPath: string;
    authenticationPath: string;
    authenticationHeaders: HeadersInit;
}

function successfulEndpointProbe(response: Response): EndpointProbe {
    return { reachable: true, ok: response.ok, httpStatus: response.status, error: null };
}

function failedEndpointProbe(error: unknown): EndpointProbe {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { reachable: false, ok: false, httpStatus: null, error: timedOut ? "timeout" : "unreachable" };
}

async function probeEndpoint(url: string, headers?: HeadersInit): Promise<EndpointProbe> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers,
            redirect: "error",
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
    if (context.credentialScope === "project_application") {
        return [
            !context.inferredSupabaseUrl ? "secureSupabaseUrl" : null,
            !context.inferredServiceRoleKey ? "serviceRoleKey" : null,
            !context.projectRef ? "projectRef" : null,
        ].filter((field): field is string => Boolean(field));
    }
    return [
        !context.apiUrl ? "apiUrl" : null,
        !context.apiToken ? "apiToken" : null,
        !context.projectRef ? "projectRef" : null,
    ].filter((field): field is string => Boolean(field));
}

function authenticatedByProbe(authentication: EndpointProbe | null): boolean | null {
    if (!authentication) return null;
    return authentication.reachable && authentication.ok;
}

function connectivityProbeIsHealthy(
    scope: ContextCredentialScope,
    connectivity: EndpointProbe | null,
): boolean | null {
    if (!connectivity) return null;
    if (scope !== "project_application") return connectivity.ok;
    return connectivity.reachable
        && (connectivity.ok || [401, 403].includes(connectivity.httpStatus ?? 0));
}

function projectApplicationHeaders(serviceRoleKey: string): HeadersInit {
    return { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
}

function projectStatusApiUrl(context: ResolvedContext): string {
    return context.credentialScope === "project_application"
        ? context.inferredSupabaseUrl
        : context.apiUrl;
}

function projectStatusProbePlan(context: ResolvedContext): ProjectStatusProbePlan {
    if (context.credentialScope === "project_application") {
        return {
            apiUrl: projectStatusApiUrl(context),
            connectivityPath: "/rest/v1/",
            authenticationPath: "/rest/v1/",
            authenticationHeaders: projectApplicationHeaders(context.inferredServiceRoleKey),
        };
    }
    return {
        apiUrl: projectStatusApiUrl(context),
        connectivityPath: "/health",
        authenticationPath: `/v1/projects/${encodeURIComponent(context.projectRef)}/health`,
        authenticationHeaders: { Authorization: `Bearer ${context.apiToken}` },
    };
}

function projectStatusChecks(
    missing: string[],
    connectivity: EndpointProbe | null,
    authentication: EndpointProbe | null,
    connectivityOk: boolean | null,
): ProjectStatusChecks {
    return {
        configuration: { ok: missing.length === 0, missing },
        connectivity: {
            ok: connectivityOk,
            reachable: connectivity?.reachable ?? null,
            httpStatus: connectivity?.httpStatus ?? null,
            error: connectivity?.error ?? null,
        },
        authentication: { ok: authenticatedByProbe(authentication), httpStatus: authentication?.httpStatus ?? null },
        project: { ok: authentication?.ok ?? null },
    };
}

async function collectProjectStatusChecks(context: ResolvedContext): Promise<ProjectStatusChecks> {
    const missing = missingProjectContextFields(context);
    const probePlan = projectStatusProbePlan(context);
    const connectivity = probePlan.apiUrl
        ? await probeEndpoint(`${probePlan.apiUrl}${probePlan.connectivityPath}`)
        : null;
    const connectivityOk = connectivityProbeIsHealthy(context.credentialScope, connectivity);
    const authentication = missing.length === 0 && connectivityOk
        ? await probeEndpoint(
            `${probePlan.apiUrl}${probePlan.authenticationPath}`,
            probePlan.authenticationHeaders,
        )
        : null;
    return projectStatusChecks(missing, connectivity, authentication, connectivityOk);
}

function projectStatusIsHealthy(checks: ProjectStatusChecks): boolean {
    return checks.configuration.ok
        && checks.connectivity.ok === true
        && checks.authentication.ok === true
        && checks.project.ok === true;
}

async function createProjectStatusResult(context: ResolvedContext) {
    const checks = await collectProjectStatusChecks(context);
    const statusApiUrl = projectStatusApiUrl(context);
    const statusPayload = {
        mode: "project",
        credentialScope: context.credentialScope,
        environment: context.environment || null,
        source: { kind: context.source, path: context.sourcePath },
        projectRef: context.projectRef || null,
        apiUrl: statusApiUrl || null,
        readOnly: context.readOnly,
        production: context.production,
        autoLinked: Boolean(context.inferredSupabaseUrl && context.inferredServiceRoleKey),
        hasApiToken: context.credentialScope === "project_application"
            ? Boolean(context.inferredServiceRoleKey)
            : Boolean(context.apiToken),
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

function printHelp(context: ResolvedContext) {
    const autoLink = context.inferredSupabaseUrl
        ? `Project context: ${context.inferredSupabaseUrl} (${context.source})`
        : "Project context: not detected";

    console.error(`
╔═══════════════════════════════════════════════════════════╗
║  supacloud-cli                                           ║
║  Project CLI for SupaCloud users                         ║
╚═══════════════════════════════════════════════════════════╝

USAGE

  ${preferredCommand} [global flags] <module> <action> [--flags]
  ${preferredCommand} [global flags] status
  ${preferredCommand} --help
  ${preferredCommand} --version

GLOBAL FLAGS

  --env <name>                    Load .env.supacloud.<name> from the current directory.
  --env-file <path>               Load an exact file that declares SUPACLOUD_ENV.
  --confirm-production <ref>      Confirm a write to the selected production project.

  Global flags may appear before or after the command. --env and --env-file are
  mutually exclusive, and a selected source is never mixed with another source.

DEFAULT CONTEXT

  Without a selector or project variables, runs use the current project's legacy .env.
  Application status accepts SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
  Management-backed project commands require SUPACLOUD_API_URL +
  SUPACLOUD_API_TOKEN. These credential scopes are never mixed.
  SUPACLOUD_PROJECT_REF is required when it cannot be inferred from <ref>.api.*.

  SUPACLOUD_READ_ONLY=true blocks remote writes. Production writes require an
  exact --confirm-production value, and cannot override the selected project ref.

  status checks configuration, the selected API scope, connectivity, and authentication.
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
  ${preferredCommand} database migration_inventory --ref abc123
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
  ${preferredCommand} edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello --expected-active-version absent
  ${preferredCommand} edge_functions deploy --ref abc123 --slug hello --prebundled-path ./dist/hello.js --expected-sha256 <sha256> --expected-active-version 4
  ${preferredCommand} edge_functions activate --ref abc123 --slug hello --version 3 --expected-active-version 4
  ${preferredCommand} scheduled_functions list --ref abc123
  ${preferredCommand} edge_functions config --ref abc123 --slug hello --verify_jwt false --background_routes "/queue/*,/render/*"
  ${preferredCommand} secrets upsert --ref abc123 --from-env API_KEY,WEBHOOK_SECRET
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

function authorizedToolMap(
    tools: ToolMap,
    context: ResolvedContext,
    confirmProduction?: string,
): ToolMap {
    validateExecutionPolicyCoverage(tools);
    for (const [moduleName, tool] of Object.entries(tools)) {
        const callback = tool.callback;
        tool.callback = async (args: Record<string, unknown>) => {
            authorizeExecution(moduleName, args, { context, confirmProduction });
            return callback(args);
        };
    }
    return tools;
}

function createCliTools(context: ResolvedContext, confirmProduction?: string): ToolMap {
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
                            "⚠️ Project commands need a Management API context.",
                            "",
                            "Provide one of these sources:",
                            "  - --env <name> for .env.supacloud.<name>",
                            "  - --env-file <path> for a file declaring SUPACLOUD_ENV",
                            "  - SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN",
                            "  - SUPACLOUD_PROJECT_REF when the profile cannot infer it",
                            "",
                            "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY application profiles",
                            "are accepted only by status and local commands.",
                            "",
                            "Then retry commands such as:",
                            `  ${preferredCommand} project get`,
                            `  ${preferredCommand} project logs --log_type database`,
                        ].join("\n"),
                    },
                ],
            }),
        };
        for (const name of ["database", "auth", "storage", "edge_functions", "secrets", "frontend", "queue", "task_events", "scheduled_functions", "diagnostics", "gateway", "branch"]) {
            tools[name] = {
                schema: { action: genericActionSchema },
                callback: async () => ({
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: `⚠️ This command requires Management API context. Run \`${preferredCommand} status\` to inspect current detection.`,
                        },
                    ],
                }),
            };
        }
        const storageContextCallback = tools.storage.callback;
        const storageHelpTool = captureTools((server) => registerStorageTools(server as any, {} as HttpTransport)).storage;
        if (storageHelpTool) {
            tools.storage = { schema: storageHelpTool.schema, callback: storageContextCallback };
        }
        const branchContextCallback = tools.branch.callback;
        const branchHelpTool = captureTools((server) => registerBranchTools(server as any, {} as any, {
            readOnly: true,
        })).branch;
        if (branchHelpTool) {
            tools.branch = { schema: branchHelpTool.schema, callback: branchContextCallback };
        }
    };

    if (context.credentialScope !== "management" || !context.apiUrl || !context.apiToken) {
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
                            `${preferredCommand} remote tools require Management API credentials.`,
                            "Provide one of these sources:",
                            "",
                            "  1. Named environment file",
                            "     supacloud-cli --env test status",
                            "",
                            "  2. Explicit environment variables",
                            "     SUPACLOUD_API_URL=https://your-project.example.com",
                            "     SUPACLOUD_API_TOKEN=...",
                            "     SUPACLOUD_PROJECT_REF=your-project-ref",
                            "",
                            "Application SUPABASE_* profiles remain available to status and local commands.",
                            "",
                            "For server installation and tenant management, use:",
                            "  supacloud-admin",
                        ].join("\n"),
                    },
                ],
            }),
        };
        return authorizedToolMap(tools, context, confirmProduction);
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
    assign(captureTools((server) => registerAdvancedTools(server as any, http, process.env, {
        readOnly: context.readOnly,
    })));
    assign(captureTools((server) => registerScheduledFunctionTools(server as any, http, process.env, {
        readOnly: context.readOnly,
    })));
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
    return authorizedToolMap(tools, context, confirmProduction);
}

async function main() {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.length === 1 && rawArgs[0] === "--version") {
        console.log(packageMetadata.version);
        return;
    }
    const globalOptions = parseGlobalOptions(rawArgs);
    const args = globalOptions.args;
    const context = resolveSupaCloudContext(process.env, process.cwd(), {
        environmentName: globalOptions.environmentName,
        envFile: globalOptions.envFile,
    });
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp(context);
        process.exitCode = 0;
        return;
    }

    const cliTools = createCliTools(context, globalOptions.confirmProduction);
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
    process.exitCode = 1;
});
