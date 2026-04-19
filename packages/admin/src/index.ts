#!/usr/bin/env node

import { runCli } from "../../mcp-server/src/cli";
import { resolveSupaCloudContext } from "../../mcp-server/src/context";
import { HttpTransport } from "../../mcp-server/src/transports/http";
import { SshTransport } from "../../mcp-server/src/transports/ssh";
import { registerSshTools } from "../../mcp-server/src/tools/ssh-tools";
import { registerProjectTools } from "../../mcp-server/src/tools/project-tools";
import { registerAdvancedTools } from "../../mcp-server/src/tools/advanced-tools";

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
    console.error(`
╔═══════════════════════════════════════════════════════════╗
║  supacloud-admin                                         ║
║  Platform administration CLI for SupaCloud operators     ║
╚═══════════════════════════════════════════════════════════╝

USAGE

  supacloud-admin <module> <action> [--flags]
  supacloud-admin status
  supacloud-admin --help

EXPECTED CONTEXT

  Platform commands typically rely on:
    SUPACLOUD_HOST
    SUPACLOUD_SSH_KEY / SUPACLOUD_SSH_PASS
    SUPACLOUD_API_URL
    SUPACLOUD_API_TOKEN

  Detected host: ${context.host || "(none)"}
  Detected API URL: ${context.apiUrl || "(none)"}

EXAMPLES

  supacloud-admin status
  supacloud-admin ssh ping
  supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
  supacloud-admin project list
  supacloud-admin platform metrics
`);
}

function createAdminTools(): ToolMap {
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
                                mode: "admin",
                                host: context.host || null,
                                apiUrl: context.apiUrl || null,
                                hasApiToken: Boolean(context.apiToken),
                                hasSshKey: Boolean(context.sshKey),
                                source: context.source,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            }),
        },
    };

    if (context.host) {
        const ssh = new SshTransport({
            host: context.host,
            port: context.sshPort,
            username: context.sshUser,
            privateKeyPath: context.sshKey || undefined,
            password: context.sshPass || undefined,
        });
        Object.assign(tools, captureTools((server) => registerSshTools(server as any, ssh)));
    }

    if (context.apiUrl && context.apiToken) {
        const http = new HttpTransport({
            baseUrl: context.apiUrl,
            token: context.apiToken,
        });

        Object.assign(tools, captureTools((server) => registerProjectTools(server as any, http)));

        const advancedTools = captureTools((server) => registerAdvancedTools(server as any, http));
        if (advancedTools.platform) {
            tools.platform = advancedTools.platform;
        }
    }

    if (Object.keys(tools).length === 1) {
        tools.setup_help = {
            schema: {},
            callback: async () => ({
                content: [
                    {
                        type: "text" as const,
                        text: [
                            "⚠️ No admin context configured.",
                            "",
                            "Provide one or both of:",
                            "  SUPACLOUD_HOST + SSH credentials",
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

    return tools;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp();
        process.exit(0);
    }

    const cliTools = createAdminTools();
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
    await runCli(cliTools, args, { commandName: "supacloud-admin" });
}

main().catch((error) => {
    console.error("supacloud-admin failed:", error);
    process.exit(1);
});
