/**
 * Project Management — Compound tool (12→1)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

const formatTasks = (data: unknown): string => {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return "No tasks found.";
    const emoji: Record<string, string> = { pending: "⏳", processing: "🔄", completed: "✅", failed: "❌" };
    let out = `📋 Tasks (${data.length}):\n\n`;
    for (const t of data as any[]) {
        out += `  ${emoji[t.status] || "❓"} ${t.task_type} — ${t.status}\n     ID: ${t.id}\n`;
        if (t.retries > 0) out += `     Retries: ${t.retries}\n`;
        if (t.error) out += `     Error: ${t.error}\n`;
        if (t.created_at) out += `     Created: ${t.created_at}\n`;
        out += "\n";
    }
    return out;
};

export function registerProjectTools(server: McpServer, http: HttpTransport): void {
    server.tool(
        "project",
        `Project lifecycle management.
Actions: list, create, get, delete, pause, restore, health, logs, api_keys, restart, settings, update_settings, tasks`,
        {
            action: z.enum([
                "list", "create", "get", "delete", "pause", "restore",
                "health", "logs", "api_keys", "restart",
                "settings", "update_settings", "tasks",
            ]).describe("Action to perform"),
            ref: z.string().optional().describe("Project ref (required for most actions except 'list' and 'create')"),
            // create params
            name: z.string().optional().describe("[create] Project name"),
            region: z.string().optional().describe("[create] Region (default: local)"),
            organization_id: z.string().optional().describe("[create] Organization ID"),
            // update_settings params
            settings: z.record(z.unknown()).optional().describe("[update_settings] Config fields to update"),
            // logs params
            log_type: z.enum(["all", "auth", "database", "api"]).optional().describe("[logs] Filter by service"),
        },
        async ({ action, ref, name, region, organization_id, settings, log_type }) => {
            const need = (field: string) => { if (!ref) throw new Error(`'ref' is required for action '${action}'`); };
            const ok = (res: any) => res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;
            const simple = (res: any, msg: string) => res.ok ? `✅ ${msg}` : `❌ Failed (${res.status})`;

            let text: string;
            switch (action) {
                case "list":
                    text = ok(await http.get("/v1/projects"));
                    break;
                case "create":
                    if (!name) throw new Error("'name' is required for create");
                    text = ok(await http.post("/v1/projects", { name, region: region || "local", organization_id }));
                    break;
                case "get":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}`));
                    break;
                case "delete":
                    need("ref"); text = simple(await http.delete(`/v1/projects/${ref}`), `Project ${ref} deleted`);
                    break;
                case "pause":
                    need("ref"); text = simple(await http.post(`/v1/projects/${ref}/pause`), `Project ${ref} paused`);
                    break;
                case "restore":
                    need("ref"); text = simple(await http.post(`/v1/projects/${ref}/restore`), `Project ${ref} restored`);
                    break;
                case "health":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/health`));
                    break;
                case "logs": {
                    const t = log_type || "all";
                    let endpoint = `/mcp/logs?type=${t}`;
                    if (ref) endpoint += `&ref=${ref}`;
                    text = ok(await http.get(endpoint));
                    break;
                }
                case "api_keys":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/api-keys`));
                    break;
                case "restart":
                    need("ref"); text = simple(await http.post(`/v1/projects/${ref}/restart`), "Restart completed");
                    break;
                case "settings":
                    need("ref"); text = ok(await http.get(`/v1/projects/${ref}/settings`));
                    break;
                case "update_settings":
                    need("ref");
                    if (!settings) throw new Error("'settings' is required for update_settings");
                    text = ok(await http.put(`/v1/projects/${ref}/settings`, settings));
                    break;
                case "tasks":
                    need("ref");
                    const res = await http.get(`/v1/projects/${ref}/tasks`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                default:
                    text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
