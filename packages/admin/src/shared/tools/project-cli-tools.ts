import { z } from "zod";
import type { HttpTransport } from "../transports/http";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: Record<string, z.ZodTypeAny>,
        callback: (args: any) => Promise<any>,
    ) => void;
};

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

const ok = (res: any) => res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;
const simple = (res: any, msg: string) => res.ok ? `✅ ${msg}` : `❌ Failed (${res.status})`;

function buildProjectLogsPath(ref: string, logType?: string): string {
    const params = new URLSearchParams({ limit: "200" });
    if (logType && logType !== "all") {
        params.set("service", logType);
    }
    return `/v1/projects/${ref}/logs?${params.toString()}`;
}

function resolveRef(refFromArgs: string | undefined, defaultRef?: string): string {
    const ref = defaultRef || refFromArgs;
    if (!ref) throw new Error("'ref' is required for this action");
    return ref;
}

export function registerUserProjectCliTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectRef?: string } = {},
): void {
    const { projectRef } = options;

    server.tool(
        "project",
        "Project-scoped inspection and developer operations. Actions: get, health, logs, api_keys, settings, tasks",
        {
            action: z.enum(["get", "health", "logs", "api_keys", "settings", "tasks"]).describe("Action to perform"),
            ref: z.string().optional().describe(projectRef ? "Optional override when not auto-linked" : "Project ref"),
            log_type: z.enum(["all", "auth", "database", "api"]).optional().describe("[logs] Filter by service"),
        },
        async ({ action, ref, log_type }) => {
            const resolvedRef = resolveRef(ref, projectRef);
            let text: string;

            switch (action) {
                case "get":
                    text = ok(await http.get(`/v1/projects/${resolvedRef}`));
                    break;
                case "health":
                    text = ok(await http.get(`/v1/projects/${resolvedRef}/health`));
                    break;
                case "logs": {
                    const type = log_type || "all";
                    text = ok(await http.get(buildProjectLogsPath(resolvedRef, type)));
                    break;
                }
                case "api_keys":
                    text = ok(await http.get(`/v1/projects/${resolvedRef}/api-keys`));
                    break;
                case "settings":
                    text = ok(await http.get(`/v1/projects/${resolvedRef}/settings`));
                    break;
                case "tasks": {
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}

export function registerAdminProjectCliTools(server: ToolServer, http: HttpTransport): void {
    server.tool(
        "project",
        "Platform-level project lifecycle management. Actions: list, create, get, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks",
        {
            action: z.enum([
                "list", "create", "get", "delete", "pause", "restore",
                "restart", "settings", "update_settings", "api_keys",
                "health", "logs", "tasks",
            ]).describe("Action to perform"),
            ref: z.string().optional().describe("Project ref (required for most actions except 'list' and 'create')"),
            name: z.string().optional().describe("[create] Project name"),
            region: z.string().optional().describe("[create] Region (default: local)"),
            organization_id: z.string().optional().describe("[create] Organization ID"),
            settings: z.record(z.string(), z.unknown()).optional().describe("[update_settings] Config fields to update"),
            log_type: z.enum(["all", "auth", "database", "api"]).optional().describe("[logs] Filter by service"),
        },
        async ({ action, ref, name, region, organization_id, settings, log_type }) => {
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
                    text = ok(await http.get(`/v1/projects/${resolveRef(ref)}`));
                    break;
                case "delete": {
                    const resolvedRef = resolveRef(ref);
                    text = simple(await http.delete(`/v1/projects/${resolvedRef}`), `Project ${resolvedRef} deleted`);
                    break;
                }
                case "pause": {
                    const resolvedRef = resolveRef(ref);
                    text = simple(await http.post(`/v1/projects/${resolvedRef}/pause`), `Project ${resolvedRef} paused`);
                    break;
                }
                case "restore": {
                    const resolvedRef = resolveRef(ref);
                    text = simple(await http.post(`/v1/projects/${resolvedRef}/restore`), `Project ${resolvedRef} restored`);
                    break;
                }
                case "restart": {
                    const resolvedRef = resolveRef(ref);
                    text = simple(await http.post(`/v1/projects/${resolvedRef}/restart`), "Restart completed");
                    break;
                }
                case "settings":
                    text = ok(await http.get(`/v1/projects/${resolveRef(ref)}/settings`));
                    break;
                case "update_settings": {
                    const resolvedRef = resolveRef(ref);
                    if (!settings) throw new Error("'settings' is required for update_settings");
                    text = ok(await http.put(`/v1/projects/${resolvedRef}/settings`, settings));
                    break;
                }
                case "api_keys":
                    text = ok(await http.get(`/v1/projects/${resolveRef(ref)}/api-keys`));
                    break;
                case "health":
                    text = ok(await http.get(`/v1/projects/${resolveRef(ref)}/health`));
                    break;
                case "logs": {
                    const resolvedRef = resolveRef(ref);
                    const type = log_type || "all";
                    text = ok(await http.get(buildProjectLogsPath(resolvedRef, type)));
                    break;
                }
                case "tasks": {
                    const res = await http.get(`/v1/projects/${resolveRef(ref)}/tasks`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}
