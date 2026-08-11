import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: any) => Promise<any>,
    ) => void;
};

const PROJECT_SERVICE_NAMES = [
    "postgrest", "gotrue", "storage", "postgresql", "realtime", "gateway",
] as const;
const PROJECT_SERVICE_CONTROL_ACTIONS = [
    "start", "stop", "restart", "pause", "resume", "status",
] as const;

type ProjectServiceName = typeof PROJECT_SERVICE_NAMES[number];
type ProjectServiceControlAction = typeof PROJECT_SERVICE_CONTROL_ACTIONS[number];

const SUPPORTED_PROJECT_SERVICE_ACTIONS: Record<
    ProjectServiceName,
    readonly ProjectServiceControlAction[]
> = {
    postgrest: ["start", "stop", "restart", "pause", "resume", "status"],
    gotrue: ["start", "stop", "restart"],
    storage: ["start", "stop", "restart"],
    postgresql: ["start", "stop", "restart"],
    realtime: ["start", "stop", "restart"],
    gateway: ["start", "stop", "restart"],
};

type ProjectToolResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

function projectToolResponse(text: string): ProjectToolResponse {
    return { content: [{ type: "text", text }] };
}

function failedProjectServiceResponse(message: string): ProjectToolResponse {
    return {
        content: [{ type: "text", text: `❌ ${message}` }],
        isError: true,
    };
}

function failedProjectServiceHttpResponse(response: HttpResult<unknown>): ProjectToolResponse {
    return failedProjectServiceResponse(
        `Failed (${response.status}): ${JSON.stringify(response.data)}`,
    );
}

function isRecordPayload(payload: unknown): payload is Record<string, unknown> {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isProjectServiceStatus(payload: unknown): boolean {
    if (!isRecordPayload(payload)) return false;
    return typeof payload.id === "string"
        && typeof payload.name === "string"
        && typeof payload.status === "string"
        && typeof payload.healthy === "boolean"
        && Array.isArray(payload.service_host_ids)
        && payload.service_host_ids.every((hostId) => typeof hostId === "string");
}

function projectServicesResponse(
    projectRef: string,
    response: HttpResult<unknown>,
): ProjectToolResponse {
    if (!response.ok) return failedProjectServiceHttpResponse(response);
    if (!Array.isArray(response.data) || !response.data.every(isProjectServiceStatus)) {
        return failedProjectServiceResponse("Project service inventory response is invalid");
    }
    return projectToolResponse(JSON.stringify({ project_ref: projectRef, services: response.data }, null, 2));
}

function supportsProjectServiceAction(
    service: ProjectServiceName,
    action: ProjectServiceControlAction,
): boolean {
    return SUPPORTED_PROJECT_SERVICE_ACTIONS[service].includes(action);
}

function projectServiceReceiptError(
    receipt: unknown,
    requestedService: ProjectServiceName,
    requestedAction: ProjectServiceControlAction,
): string | null {
    if (!isRecordPayload(receipt)) return "Project service control response is invalid";
    if (receipt.service !== requestedService || receipt.action !== requestedAction) {
        return "Project service control response does not match the request";
    }
    if (receipt.success !== true || typeof receipt.message !== "string") {
        return `Project service control failed: ${JSON.stringify(receipt)}`;
    }
    return null;
}

function projectServiceControlResponse(
    projectRef: string,
    requestedService: ProjectServiceName,
    requestedAction: ProjectServiceControlAction,
    response: HttpResult<unknown>,
): ProjectToolResponse {
    if (!response.ok) return failedProjectServiceHttpResponse(response);
    const receiptError = projectServiceReceiptError(response.data, requestedService, requestedAction);
    if (receiptError) return failedProjectServiceResponse(receiptError);
    return projectToolResponse(JSON.stringify({
        project_ref: projectRef,
        service: requestedService,
        action: requestedAction,
        success: true,
        receipt: response.data,
    }, null, 2));
}

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
            action: withDescription(stringEnum(["get", "health", "logs", "api_keys", "settings", "tasks"]), "Action to perform"),
            ref: optional(Type.String(), projectRef ? "Optional override when not auto-linked" : "Project ref"),
            log_type: optional(stringEnum(["all", "auth", "database", "api"]), "[logs] Filter by service"),
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
        "Platform-level project lifecycle management. Actions: list, create, get, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, services, service_control",
        {
            action: withDescription(stringEnum([
                "list", "create", "get", "delete", "pause", "restore",
                "restart", "settings", "update_settings", "api_keys",
                "health", "logs", "tasks", "services", "service_control",
            ]), "Action to perform"),
            ref: optional(Type.String(), "[*] Project ref (required for most actions except 'list' and 'create')"),
            name: optional(Type.String(), "[create] Project name"),
            region: optional(Type.String(), "[create] Region (default: local)"),
            organization_id: optional(Type.String(), "[create] Organization ID"),
            domain: optional(Type.String(), "[create] Base custom domain"),
            api_domain: optional(Type.String(), "[create] Explicit API domain"),
            auth_domain: optional(Type.String(), "[create] Explicit Auth/OIDC domain"),
            studio_domain: optional(Type.String(), "[create] Explicit Studio domain"),
            settings: optional(Type.Record(Type.String(), Type.Unknown()), "[update_settings] Config fields to update"),
            log_type: optional(stringEnum(["all", "auth", "database", "api"]), "[logs] Filter by service"),
            service: optional(stringEnum(PROJECT_SERVICE_NAMES), "[service_control] Canonical service name"),
            service_action: optional(
                stringEnum(PROJECT_SERVICE_CONTROL_ACTIONS),
                "[service_control] Supported action for the selected service",
            ),
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
            service,
            service_action,
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
                    const res = await http.get(`/v1/projects/${resolveRef(ref)}/tasks`);
                    text = res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "services": {
                    const resolvedRef = resolveRef(ref);
                    return projectServicesResponse(
                        resolvedRef,
                        await http.get(`/v1/projects/${encodeURIComponent(resolvedRef)}/services`),
                    );
                }
                case "service_control": {
                    const resolvedRef = resolveRef(ref);
                    if (!service) throw new Error("'service' is required for service_control");
                    if (!service_action) throw new Error("'service_action' is required for service_control");
                    if (!supportsProjectServiceAction(service, service_action)) {
                        throw new Error(`'${service_action}' is not supported for service '${service}'`);
                    }
                    const encodedRef = encodeURIComponent(resolvedRef);
                    const encodedService = encodeURIComponent(service);
                    const encodedAction = encodeURIComponent(service_action);
                    return projectServiceControlResponse(
                        resolvedRef,
                        service,
                        service_action,
                        await http.post(
                            `/v1/projects/${encodedRef}/services/${encodedService}/${encodedAction}`,
                        ),
                    );
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}
