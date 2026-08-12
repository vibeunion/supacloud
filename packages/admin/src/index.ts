#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { cliToolResultIsError, runCli } from "./shared/cli";
import { resolveSupaCloudContext, type ResolvedContext } from "./shared/context";
import { parseGlobalAdminOptions } from "./shared/global-options";
import { authorizeExecution, validateExecutionPolicyCoverage } from "./shared/execution-policy";
import { HttpTransport } from "./shared/transports/http";
import { SshTransport } from "./shared/transports/ssh";
import { registerSshTools } from "./shared/tools/ssh-tools";
import { registerAdvancedTools } from "./shared/tools/advanced-tools";
import { registerAdminProjectCliTools } from "./shared/tools/project-cli-tools";
import { registerGatewayTools } from "./shared/tools/gateway-tools";
import packageMetadata from "../package.json" with { type: "json" };

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

function unavailableTool(schema: ToolEntry["schema"], message: string): ToolEntry {
    return {
        schema,
        callback: async () => ({
            isError: true,
            content: [{ type: "text" as const, text: message }],
        }),
    };
}

function unavailableAdminSchemas(): Record<"project" | "platform" | "gateway" | "ssh", ToolEntry["schema"]> {
    const schemaOnlyHttp = {} as HttpTransport;
    return {
        project: captureTools((server) =>
            registerAdminProjectCliTools(server as any, schemaOnlyHttp)).project.schema,
        platform: captureTools((server) =>
            registerAdvancedTools(server as any, schemaOnlyHttp)).platform.schema,
        gateway: captureTools((server) =>
            registerGatewayTools(server as any, schemaOnlyHttp)).gateway.schema,
        ssh: captureTools((server) =>
            registerSshTools(server as any, {} as SshTransport)).ssh.schema,
    };
}

function registerUnavailableAdminTools(tools: ToolMap): void {
    const schemas = unavailableAdminSchemas();
    tools.project = unavailableTool(schemas.project,
        "⚠️ Project lifecycle commands require SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN.");
    tools.platform = unavailableTool(schemas.platform,
        "⚠️ Platform commands require SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN.");
    tools.ssh = unavailableTool(schemas.ssh,
        "⚠️ SSH commands require SUPACLOUD_HOST, SSH credentials, and SUPACLOUD_SSH_HOST_FINGERPRINT.");
    tools.gateway = unavailableTool(schemas.gateway,
        "⚠️ Gateway / Caddy commands require SUPACLOUD_API_URL and SUPACLOUD_API_TOKEN (admin privileges).");
}

function printHelp(context = resolveSupaCloudContext()) {
    console.error(`
╔═══════════════════════════════════════════════════════════╗
║  supacloud-admin                                         ║
║  Platform administration CLI for SupaCloud operators     ║
╚═══════════════════════════════════════════════════════════╝

USAGE

  supacloud-admin [global flags] <module> <action> [--flags]
  supacloud-admin [global flags] status
  supacloud-admin --help
  supacloud-admin --version

GLOBAL FLAGS

  --env <name>                    Load .env.supacloud.<name> from the current directory.
  --env-file <path>               Load an exact file that declares SUPACLOUD_ENV.
  --confirm-production <target>   Confirm the exact production project or platform target.

  Global flags may appear before or after the command. --env and --env-file are
  mutually exclusive, and a selected source is never mixed with another source.

EXPECTED CONTEXT

  Platform commands typically rely on:
    SUPACLOUD_HOST
    SUPACLOUD_SSH_KEY / SUPACLOUD_SSH_PASS
    SUPACLOUD_SSH_HOST_FINGERPRINT=SHA256:...
    SUPACLOUD_API_URL
    SUPACLOUD_API_TOKEN
    SUPACLOUD_ENV
    SUPACLOUD_READ_ONLY

  Environment: ${context.environment || "(unclassified)"}
  Context source: ${context.source}${context.sourcePath ? ` (${context.sourcePath})` : ""}
  Detected host: ${context.host || "(none)"}
  Detected API URL: ${context.apiUrl || "(none)"}

  SUPACLOUD_READ_ONLY=true blocks every remote write. Production project writes
  require the exact project ref. Production writes without a project ref use
  platform:<API host> or host:<SSH host[:port]> as the confirmation target.

EXAMPLES

  supacloud-admin status
  supacloud-admin ssh ping
  supacloud-admin ssh versions
  supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
  supacloud-admin project create --name my-app --domain example.com --env_file /secure/path/.env.project-credentials.test --environment test
  supacloud-admin project list
  supacloud-admin project services --ref abc123
  supacloud-admin project runtime_snapshot --ref abc123
  supacloud-admin project service_control --ref abc123 --service gotrue --service_action stop
  supacloud-admin platform metrics
  supacloud-admin gateway routes --ref abc123
  supacloud-admin gateway upsert_route --ref abc123 --route_id webhook --hosts "api.example.com" --paths "/webhook/*" --upstream 10.0.0.5:8080
  supacloud-admin gateway config --ref abc123 --rate_limit_tier pro
  supacloud-admin gateway rebuild --ref abc123 --clean
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

export function createAdminTools(
    context: ResolvedContext = resolveSupaCloudContext(),
    confirmProduction?: string,
): ToolMap {
    const tools: ToolMap = {
        status: {
            schema: {},
            callback: async () => ({
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                mode: "admin",
                                host: context.host || null,
                                apiUrl: context.apiUrl || null,
                                hasApiToken: Boolean(context.apiToken),
                                hasSshKey: Boolean(context.sshKey),
                                hasSshHostFingerprint: Boolean(context.sshHostFingerprint),
                                environment: context.environment || null,
                                production: context.production,
                                readOnly: context.readOnly,
                                source: { kind: context.source, path: context.sourcePath },
                            },
                            null,
                            2,
                        ),
                    },
                ],
            }),
        },
    };

    registerUnavailableAdminTools(tools);

    if (context.host && context.sshHostFingerprint) {
        try {
            const ssh = new SshTransport({
                host: context.host,
                port: context.sshPort,
                username: context.sshUser,
                privateKeyPath: context.sshKey || undefined,
                password: context.sshPass || undefined,
                hostFingerprint: context.sshHostFingerprint,
            });
            Object.assign(tools, captureTools((server) => registerSshTools(server as any, ssh)));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            tools.ssh = {
                schema: tools.ssh.schema,
                callback: async () => ({
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `⚠️ SSH host fingerprint is invalid; SSH actions remain disabled. ${message}`,
                    }],
                }),
            };
        }
    } else if (context.host) {
        tools.ssh = {
            schema: tools.ssh.schema,
            callback: async () => ({
                isError: true,
                content: [{
                    type: "text" as const,
                    text: [
                        "⚠️ SSH actions are disabled because host-key verification is not configured.",
                        "Set SUPACLOUD_SSH_HOST_FINGERPRINT to the server's OpenSSH SHA256 fingerprint.",
                        `Verify it out-of-band first, for example: ssh-keyscan -p ${context.sshPort} ${context.host} | ssh-keygen -lf -`,
                    ].join("\n"),
                }],
            }),
        };
    }

    if (context.apiUrl && context.apiToken) {
        const http = new HttpTransport({
            baseUrl: context.apiUrl,
            token: context.apiToken,
        });

        Object.assign(tools, captureTools((server) => registerAdminProjectCliTools(server as any, http)));
        Object.assign(tools, captureTools((server) => registerGatewayTools(server as any, http)));

        const advancedTools = captureTools((server) => registerAdvancedTools(server as any, http));
        if (advancedTools.platform) {
            tools.platform = advancedTools.platform;
        }
    }

    if (Object.keys(tools).length === 1) {
        tools.setup_help = {
            schema: {},
            callback: async () => ({
                isError: true,
                content: [
                    {
                        type: "text" as const,
                        text: [
                            "⚠️ No admin context configured.",
                            "",
                            "Provide one or both of:",
                            "  SUPACLOUD_HOST + SSH credentials + SUPACLOUD_SSH_HOST_FINGERPRINT",
                            "  SUPACLOUD_API_URL + SUPACLOUD_API_TOKEN",
                            "",
                            "This CLI is intended for server installation, diagnostics, and",
                            "platform-wide administration.",
                        ].join("\n"),
                    },
                ],
            }),
        };
    }

    return authorizedToolMap(tools, context, confirmProduction);
}

async function main() {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.length === 1 && rawArgs[0] === "--version") {
        console.log(packageMetadata.version);
        return;
    }
    const globalOptions = parseGlobalAdminOptions(rawArgs);
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

    const cliTools = createAdminTools(context, globalOptions.confirmProduction);
    if (args.length === 1 && cliTools[args[0]]) {
        const toolResponse = await cliTools[args[0]].callback({});
        if (toolResponse?.content && Array.isArray(toolResponse.content)) {
            for (const chunk of toolResponse.content) {
                if (chunk.type === "text") {
                    console.log(chunk.text);
                }
            }
        } else {
            console.log(JSON.stringify(toolResponse, null, 2));
        }
        if (cliToolResultIsError(toolResponse)) process.exitCode = 1;
        return;
    }
    await runCli(cliTools, args, { commandName: "supacloud-admin" });
}

function isDirectRun(): boolean {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    main().catch((error) => {
        console.error("supacloud-admin failed:", error);
        process.exit(1);
    });
}
