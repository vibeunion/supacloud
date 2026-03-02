/**
 * Advanced Tools - Edge Functions, Secrets, Auth Config, Backup
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerAdvancedTools(server: McpServer, http: HttpTransport): void {
    // ═══════════════════════════════════════
    //  Edge Functions
    // ═══════════════════════════════════════

    server.tool(
        "list_edge_functions",
        "List all Edge Functions for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/functions`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "deploy_edge_function",
        "Deploy an Edge Function to a project",
        {
            ref: z.string().describe("Project ref"),
            slug: z.string().describe("Function name (slug)"),
            code: z.string().describe("Function source code (TypeScript)"),
        },
        async ({ ref, slug, code }) => {
            const res = await http.post(`/v1/projects/${ref}/functions/${slug}`, { code });
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Function ${slug} deployed successfully`
                            : `❌ Deployment failed (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    server.tool(
        "delete_edge_function",
        "Delete an Edge Function from a project",
        {
            ref: z.string().describe("Project ref"),
            slug: z.string().describe("Function name"),
        },
        async ({ ref, slug }) => {
            const res = await http.delete(`/v1/projects/${ref}/functions/${slug}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Function ${slug} deleted` : `❌ Deletion failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Secrets
    // ═══════════════════════════════════════

    server.tool(
        "list_secrets",
        "List all Secrets (environment variables) for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/secrets`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "upsert_secrets",
        "Create or update project Secrets",
        {
            ref: z.string().describe("Project ref"),
            secrets: z
                .array(z.object({ name: z.string(), value: z.string() }))
                .describe("Secret list, e.g. [{name: 'API_KEY', value: '...'}]"),
        },
        async ({ ref, secrets }) => {
            const res = await http.post(`/v1/projects/${ref}/secrets`, secrets);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Updated ${secrets.length} Secrets`
                            : `❌ Update failed (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "delete_secret",
        "Delete a Secret from a project",
        {
            ref: z.string().describe("Project ref"),
            name: z.string().describe("Secret name"),
        },
        async ({ ref, name }) => {
            const res = await http.delete(`/v1/projects/${ref}/secrets/${name}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Secret ${name} deleted` : `❌ Deletion failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Auth Config
    // ═══════════════════════════════════════

    server.tool(
        "get_auth_config",
        "Get project Auth config (SMTP, OAuth providers, etc.)",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/config/auth`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "update_auth_config",
        "Update project Auth config, can enable multiple OAuth providers or configure SMTP at once",
        {
            ref: z.string().describe("Project ref"),
            config: z
                .record(z.unknown())
                .describe(
                    "Auth config object, e.g.: {external_google_enabled: true, external_google_client_id: '...'}"
                ),
        },
        async ({ ref, config }) => {
            const res = await http.patch(`/v1/projects/${ref}/config/auth`, config);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Auth config updated`
                            : `❌ Update failed (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Backup
    // ═══════════════════════════════════════

    server.tool(
        "list_backups",
        "List all database backups for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/database/backups`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "create_backup",
        "Create a database backup for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/database/backups`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Backup task created\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ Backup failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Monitoring
    // ═══════════════════════════════════════

    server.tool(
        "get_system_metrics",
        "Get system-level monitoring metrics for SupaCloud platform",
        {},
        async () => {
            const res = await http.get("/v1/monitor/system");
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    // ═══════════════════════════════════════
    //  Security
    // ═══════════════════════════════════════

    server.tool(
        "get_network_restrictions",
        "Get project network access restriction rules",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/network-restrictions`);
            return {
                content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            };
        }
    );

    server.tool(
        "update_network_restrictions",
        "Update project network access restrictions (IP whitelist)",
        {
            ref: z.string().describe("Project ref"),
            restrictions: z
                .object({
                    allowedCidrs: z.array(z.string()).describe("List of allowed CIDRs"),
                })
                .describe("Network restriction config"),
        },
        async ({ ref, restrictions }) => {
            const res = await http.put(`/v1/projects/${ref}/network-restrictions`, restrictions);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Network restrictions updated`
                            : `❌ Update failed (${res.status})`,
                    },
                ],
            };
        }
    );
}
