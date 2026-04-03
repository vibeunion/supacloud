/**
 * Project Management Tools - Operations via Management API (HTTP)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerProjectTools(server: McpServer, http: HttpTransport): void {
    // ── List all projects ──
    server.tool(
        "list_projects",
        "List all Supabase projects on SupaCloud",
        {},
        async () => {
            const res = await http.get("/v1/projects");
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Request failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Create project ──
    server.tool(
        "create_project",
        "Create a new Supabase project",
        {
            name: z.string().describe("Project name"),
            region: z.string().default("local").describe("Region"),
            organization_id: z.string().optional().describe("Organization ID"),
        },
        async ({ name, region, organization_id }) => {
            const res = await http.post("/v1/projects", { name, region, organization_id });
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Project created successfully\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ Creation failed (${res.status}): ${JSON.stringify(res.data)}`,
                    },
                ],
            };
        }
    );

    // ── Get project details ──
    server.tool(
        "get_project",
        "Get Supabase project details",
        {
            ref: z.string().describe("Project ref (short ID)"),
        },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Project not found (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Delete project ──
    server.tool(
        "delete_project",
        "Delete a Supabase project (soft delete)",
        {
            ref: z.string().describe("Project ref"),
        },
        async ({ ref }) => {
            const res = await http.delete(`/v1/projects/${ref}`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Project ${ref} deleted` : `❌ Deletion failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Pause / Restore project ──
    server.tool(
        "pause_project",
        "Pause a Supabase project to release resources",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/pause`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Project ${ref} paused` : `❌ Pause failed (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "restore_project",
        "Restore a paused Supabase project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/restore`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Project ${ref} restored` : `❌ Restore failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Project health check ──
    server.tool(
        "get_project_health",
        "Get project health status and service running status",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/health`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Request failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Get API Keys ──
    server.tool(
        "get_api_keys",
        "Get project anon_key and service_role_key",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/api-keys`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Request failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Restart project ──
    server.tool(
        "restart_project",
        "Restart all container services for the project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.post(`/v1/projects/${ref}/restart`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok ? `✅ Restart completed` : `❌ Restart failed (${res.status})`,
                    },
                ],
            };
        }
    );

    // ── Project config management ──
    server.tool(
        "get_project_settings",
        "Get project config (domain, runtime, storage, etc.)",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/settings`);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Request failed (${res.status})`,
                    },
                ],
            };
        }
    );

    server.tool(
        "update_project_settings",
        "Update project config",
        {
            ref: z.string().describe("Project ref"),
            settings: z.record(z.unknown()).describe("Config fields to update (JSON object)"),
        },
        async ({ ref, settings }) => {
            const res = await http.put(`/v1/projects/${ref}/settings`, settings);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? `✅ Config updated\n${JSON.stringify(res.data, null, 2)}`
                            : `❌ Update failed (${res.status})`,
                    },
                ],
            };
        }
    );
    // ── Get project logs ──
    server.tool(
        "fetch_project_logs",
        "Fetch the real-time container log output for project services",
        {
            ref: z.string().optional().describe("Project ref (Optional if tenant scoped)"),
            type: z.enum(["all", "auth", "database", "api"]).default("all").describe("Filter logs by service source"),
        },
        async ({ ref, type }) => {
            // Support thick-client environment variables mapping if ref omitted
            let endpoint = `/mcp/logs?type=${type}`;
            if (ref) endpoint += `&ref=${ref}`;
            
            const res = await http.get(endpoint);
            return {
                content: [
                    {
                        type: "text",
                        text: res.ok
                            ? JSON.stringify(res.data, null, 2)
                            : `❌ Request failed (${res.status})`,
                    },
                ],
            };
        }
    );
}
