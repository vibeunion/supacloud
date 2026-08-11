import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpTransport } from "../transports/http";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: any) => Promise<any>,
    ) => void;
};

const formatTasks = (data: unknown): string => {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return "No tasks found.";
    const emoji: Record<string, string> = {
        pending: "⏳", leased: "🔓", running: "🔄", retry_scheduled: "🔁",
        succeeded: "✅", failed: "❌", dead_lettered: "💀", cancelled: "🚫",
        queued: "📥", processing: "🔄", completed: "✅",
    };
    let out = `📋 Tasks (${data.length}):\n\n`;
    for (const t of data as any[]) {
        const st = t.status || "?";
        out += `  ${emoji[st] || "❓"} ${t.task_type || t.type || ""} — ${st}\n     ID: ${t.id}\n`;
        if (t.retries > 0 || t.retry_count > 0) out += `     Retries: ${t.retries || t.retry_count}\n`;
        if (t.error || t.error_message) out += `     Error: ${t.error || t.error_message}\n`;
        if (t.created_at) out += `     Created: ${t.created_at}\n`;
        out += "\n";
    }
    return out;
};

const formatTaskDetail = (data: unknown): string => {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const t = data as Record<string, unknown>;
    const emoji: Record<string, string> = {
        pending: "⏳", leased: "🔓", running: "🔄", retry_scheduled: "🔁",
        succeeded: "✅", failed: "❌", dead_lettered: "💀", cancelled: "🚫",
    };
    const st = String(t.status || "?");
    const lines = [
        `${emoji[st] || "❓"} Task Detail:`,
        `  ID:           ${t.id}`,
        `  Type:         ${t.task_type || t.type || "?"}`,
        `  Status:       ${st}`,
        `  Attempt:      ${t.attempt ?? "?"}/${t.max_attempts ?? "?"}`,
        `  Function:     ${t.function_slug || "-"}`,
        `  Created:      ${t.created_at || "?"}`,
        `  Updated:      ${t.updated_at || "-"}`,
    ];
    if (t.error || t.error_message) lines.push(`  Error:        ${t.error || t.error_message}`);
    if (t.correlation_id) lines.push(`  Correlation:  ${t.correlation_id}`);
    if (t.business_task_id) lines.push(`  Business ID:  ${t.business_task_id}`);
    if (t.trace_id) lines.push(`  Trace:        ${t.trace_id}`);
    if (t.result) lines.push(`  Result:       ${JSON.stringify(t.result).slice(0, 200)}`);
    const attempts = t.attempts as unknown[];
    if (Array.isArray(attempts) && attempts.length > 0) {
        lines.push("", `  Attempts (${attempts.length}):`);
        for (const a of attempts) {
            const aa = a as Record<string, unknown>;
            lines.push(`    #${aa.attempt_no ?? "?"} ${aa.status || ""} ${aa.error ? `— ${aa.error}` : ""}`);
        }
    }
    const logs = t.latest_logs as unknown[];
    if (Array.isArray(logs) && logs.length > 0) {
        lines.push("", `  Latest Logs (${logs.length}):`);
        for (const l of logs.slice(-10)) {
            const ll = l as Record<string, unknown>;
            lines.push(`    [${ll.stream || "?"}] ${String(ll.message || "").slice(0, 200)}`);
        }
    }
    return lines.join("\n");
};

const formatTaskStats = (data: unknown): string => {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const s = data as Record<string, unknown>;
    return [
        "📊 Task Stats:",
        `  Pending:         ${s.pending ?? "?"}`,
        `  Leased:          ${s.leased ?? "?"}`,
        `  Running:         ${s.running ?? "?"}`,
        `  Retry Scheduled: ${s.retry_scheduled ?? "?"}`,
        `  Succeeded:       ${s.succeeded ?? "?"}`,
        `  Failed:          ${s.failed ?? "?"}`,
        `  Dead Lettered:   ${s.dead_lettered ?? "?"}`,
        `  Cancelled:       ${s.cancelled ?? "?"}`,
    ].join("\n");
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
    const ref = refFromArgs || defaultRef;
    if (!ref) throw new Error("'ref' is required for this action");
    return ref;
}

// --- User-facing project tool ---

export function registerUserProjectCliTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectRef?: string } = {},
): void {
    const { projectRef } = options;

    server.tool(
        "project",
        `Project-scoped inspection and developer operations.
Actions: get, health, logs, api_keys, settings, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,
        {
            action: withDescription(stringEnum([
                "get", "health", "logs", "api_keys", "settings",
                "tasks", "task_detail", "task_cancel", "task_retry", "task_stats", "dlq",
                "background_settings", "update_background_settings",
            ]), "Action to perform"),
            ref: optional(Type.String(), projectRef ? "Optional override when not auto-linked" : "Project ref"),
            log_type: optional(stringEnum(["all", "auth", "database", "api"]), "[logs] Filter by service"),
            task_id: optional(Type.String(), "[task_detail/task_cancel/task_retry] Task ID"),
            limit: optional(Type.Number(), "[tasks/dlq] Max items to return"),
            concurrency: optional(Type.Number(), "[update_background_settings] Max concurrent background tasks"),
            max_attempts: optional(Type.Number(), "[update_background_settings] Max attempts for background tasks"),
        },
        async ({ action, ref, log_type, task_id, limit, concurrency, max_attempts }) => {
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
                    const params: Record<string, string> = {};
                    if (limit) params.limit = String(limit);
                    const qs = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks${qs}`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_detail": {
                    if (!task_id) throw new Error("'task_id' is required for task_detail");
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/${task_id}`);
                    text = res.ok ? formatTaskDetail(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_cancel": {
                    if (!task_id) throw new Error("'task_id' is required for task_cancel");
                    const res = await http.post(`/v1/projects/${resolvedRef}/tasks/${task_id}/cancel`);
                    text = res.ok ? `✅ Task ${task_id} cancelled` : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_retry": {
                    if (!task_id) throw new Error("'task_id' is required for task_retry");
                    const res = await http.post(`/v1/projects/${resolvedRef}/tasks/${task_id}/retry`);
                    text = res.ok
                        ? `✅ Task ${task_id} queued for retry\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_stats": {
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/stats`);
                    text = res.ok ? formatTaskStats(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "dlq": {
                    const params: Record<string, string> = {};
                    if (limit) params.limit = String(limit);
                    const qs = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/dlq${qs}`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "background_settings": {
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/settings/background`);
                    text = res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`;
                    break;
                }
                case "update_background_settings": {
                    const body: Record<string, unknown> = {};
                    if (concurrency) body.concurrency = concurrency;
                    if (max_attempts) body.max_attempts = max_attempts;
                    if (Object.keys(body).length === 0) throw new Error("At least one setting (concurrency or max_attempts) is required");
                    const res = await http.patch(`/v1/projects/${resolvedRef}/tasks/settings/background`, body);
                    text = res.ok
                        ? `✅ Background settings updated\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}

// --- Admin project tool ---

export function registerAdminProjectCliTools(server: ToolServer, http: HttpTransport): void {
    server.tool(
        "project",
        `Platform-level project lifecycle management.
Actions: list, create, get, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, task_detail, task_cancel, task_retry, task_stats, dlq, background_settings, update_background_settings`,
        {
            action: withDescription(stringEnum([
                "list", "create", "get", "delete", "pause", "restore",
                "restart", "settings", "update_settings", "api_keys",
                "health", "logs",
                "tasks", "task_detail", "task_cancel", "task_retry", "task_stats", "dlq",
                "background_settings", "update_background_settings",
            ]), "Action to perform"),
            ref: optional(Type.String(), "Project ref (required for most actions except 'list' and 'create')"),
            name: optional(Type.String(), "[create] Project name"),
            region: optional(Type.String(), "[create] Region (default: local)"),
            organization_id: optional(Type.String(), "[create] Organization ID"),
            domain: optional(Type.String(), "[create] Base custom domain"),
            api_domain: optional(Type.String(), "[create] Explicit API domain"),
            auth_domain: optional(Type.String(), "[create] Explicit Auth/OIDC domain"),
            studio_domain: optional(Type.String(), "[create] Explicit Studio domain"),
            settings: optional(Type.Record(Type.String(), Type.Unknown()), "[update_settings] Config fields to update"),
            log_type: optional(stringEnum(["all", "auth", "database", "api"]), "[logs] Filter by service"),
            task_id: optional(Type.String(), "[task_detail/task_cancel/task_retry] Task ID"),
            limit: optional(Type.Number(), "[tasks/dlq] Max items to return"),
            concurrency: optional(Type.Number(), "[update_background_settings] Max concurrent background tasks"),
            max_attempts: optional(Type.Number(), "[update_background_settings] Max attempts for background tasks"),
        },
        async ({
            action,
            ref,
            name,
            region,
            organization_id,
            domain,
            api_domain,
            auth_domain,
            studio_domain,
            settings,
            log_type,
            task_id,
            limit,
            concurrency,
            max_attempts,
        }) => {
            let text: string;

            switch (action) {
                case "list":
                    text = ok(await http.get("/v1/projects"));
                    break;
                case "create": {
                    if (!name) throw new Error("'name' is required for create");
                    const createRequest: Record<string, string | undefined> = {
                        name,
                        region: region || "local",
                        organization_id,
                    };
                    if (domain) createRequest.domain = domain;
                    if (api_domain) createRequest.api_domain = api_domain;
                    if (auth_domain) createRequest.auth_domain = auth_domain;
                    if (studio_domain) createRequest.studio_domain = studio_domain;
                    text = ok(await http.post("/v1/projects", createRequest));
                    break;
                }
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
                    const resolvedRef = resolveRef(ref);
                    const params: Record<string, string> = {};
                    if (limit) params.limit = String(limit);
                    const qs = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks${qs}`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_detail": {
                    const resolvedRef = resolveRef(ref);
                    if (!task_id) throw new Error("'task_id' is required for task_detail");
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/${task_id}`);
                    text = res.ok ? formatTaskDetail(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_cancel": {
                    const resolvedRef = resolveRef(ref);
                    if (!task_id) throw new Error("'task_id' is required for task_cancel");
                    const res = await http.post(`/v1/projects/${resolvedRef}/tasks/${task_id}/cancel`);
                    text = res.ok ? `✅ Task ${task_id} cancelled` : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_retry": {
                    const resolvedRef = resolveRef(ref);
                    if (!task_id) throw new Error("'task_id' is required for task_retry");
                    const res = await http.post(`/v1/projects/${resolvedRef}/tasks/${task_id}/retry`);
                    text = res.ok
                        ? `✅ Task ${task_id} queued for retry\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "task_stats": {
                    const resolvedRef = resolveRef(ref);
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/stats`);
                    text = res.ok ? formatTaskStats(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "dlq": {
                    const resolvedRef = resolveRef(ref);
                    const params: Record<string, string> = {};
                    if (limit) params.limit = String(limit);
                    const qs = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/dlq${qs}`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "background_settings": {
                    const resolvedRef = resolveRef(ref);
                    const res = await http.get(`/v1/projects/${resolvedRef}/tasks/settings/background`);
                    text = res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`;
                    break;
                }
                case "update_background_settings": {
                    const resolvedRef = resolveRef(ref);
                    const body: Record<string, unknown> = {};
                    if (concurrency) body.concurrency = concurrency;
                    if (max_attempts) body.max_attempts = max_attempts;
                    if (Object.keys(body).length === 0) throw new Error("At least one setting (concurrency or max_attempts) is required");
                    const res = await http.patch(`/v1/projects/${resolvedRef}/tasks/settings/background`, body);
                    text = res.ok
                        ? `✅ Background settings updated\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}
