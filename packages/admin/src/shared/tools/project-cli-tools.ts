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
const STUDIO_PROJECT_SERVICE_NAMES = [
    "db", "rest", "auth", "realtime", "storage",
] as const;
const STUDIO_PROJECT_SERVICE_STATUSES = [
    "ACTIVE_HEALTHY", "COMING_UP", "UNHEALTHY",
] as const;
const AUTH_RUNTIME_MANAGED_BY_OWNER = "AUTH_RUNTIME_MANAGED_BY_OWNER";
const SAFE_PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const SAFE_AUTH_SERVICE_HOST_ID = /^[a-z0-9-]{1,20}-auth$/;
const MAX_SERVICE_CONTROL_MESSAGE_LENGTH = 256;

type ProjectServiceName = typeof PROJECT_SERVICE_NAMES[number];
type ProjectServiceControlAction = typeof PROJECT_SERVICE_CONTROL_ACTIONS[number];
type StudioProjectServiceName = typeof STUDIO_PROJECT_SERVICE_NAMES[number];
type StudioProjectServiceStatus = typeof STUDIO_PROJECT_SERVICE_STATUSES[number] | "INACTIVE";
type ProjectServiceStatus = {
    id: StudioProjectServiceName;
    name: StudioProjectServiceName;
    status: StudioProjectServiceStatus;
    healthy: boolean;
    service_host_ids: [string];
};

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
    if (
        response.status === 409
        && isRecordPayload(response.data)
        && response.data.code === AUTH_RUNTIME_MANAGED_BY_OWNER
        && typeof response.data.authority_project_ref === "string"
        && SAFE_PROJECT_REF.test(response.data.authority_project_ref)
    ) {
        const ownerBoundary = {
            status: response.status,
            code: AUTH_RUNTIME_MANAGED_BY_OWNER,
            authority_project_ref: response.data.authority_project_ref,
        };
        return failedProjectServiceResponse(JSON.stringify(ownerBoundary));
    }
    return failedProjectServiceResponse(`Failed (${response.status})`);
}

function isRecordPayload(payload: unknown): payload is Record<string, unknown> {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isStudioProjectServiceName(name: unknown): name is StudioProjectServiceName {
    return typeof name === "string"
        && STUDIO_PROJECT_SERVICE_NAMES.some((allowedName) => name === allowedName);
}

function hasValidStudioServiceHealth(
    serviceId: StudioProjectServiceName,
    status: unknown,
    healthy: unknown,
): status is StudioProjectServiceStatus {
    if (status === "INACTIVE") return serviceId === "auth" && healthy === false;
    const knownStatus = STUDIO_PROJECT_SERVICE_STATUSES.some((allowedStatus) => status === allowedStatus);
    return knownStatus && healthy === (status === "ACTIVE_HEALTHY");
}

function hasValidStudioServiceHost(
    serviceId: StudioProjectServiceName,
    projectRef: string,
    hostIds: unknown,
): hostIds is [string] {
    if (!Array.isArray(hostIds) || hostIds.length !== 1 || typeof hostIds[0] !== "string") return false;
    if (serviceId === "auth") return SAFE_AUTH_SERVICE_HOST_ID.test(hostIds[0]);
    return hostIds[0] === `${projectRef}-${serviceId}`;
}

function isProjectServiceStatus(payload: unknown, projectRef: string): payload is ProjectServiceStatus {
    if (!isRecordPayload(payload)) return false;
    if (!isStudioProjectServiceName(payload.id) || payload.name !== payload.id) return false;
    return hasValidStudioServiceHealth(payload.id, payload.status, payload.healthy)
        && hasValidStudioServiceHost(payload.id, projectRef, payload.service_host_ids);
}

function projectServiceStatusOutput(status: ProjectServiceStatus): ProjectServiceStatus {
    return {
        id: status.id,
        name: status.name,
        status: status.status,
        healthy: status.healthy,
        service_host_ids: [status.service_host_ids[0]],
    };
}

function projectServicesResponse(
    projectRef: string,
    response: HttpResult<unknown>,
): ProjectToolResponse {
    if (!response.ok) return failedProjectServiceHttpResponse(response);
    if (!SAFE_PROJECT_REF.test(projectRef) || !Array.isArray(response.data) || response.data.length !== 5) {
        return failedProjectServiceResponse("Project service inventory response is invalid");
    }
    if (!response.data.every((service) => isProjectServiceStatus(service, projectRef))) {
        return failedProjectServiceResponse("Project service inventory response is invalid");
    }
    const serviceIds = new Set(response.data.map((service) => service.id));
    if (serviceIds.size !== STUDIO_PROJECT_SERVICE_NAMES.length) {
        return failedProjectServiceResponse("Project service inventory response is invalid");
    }
    const services = response.data.map(projectServiceStatusOutput);
    return projectToolResponse(JSON.stringify({ project_ref: projectRef, services }, null, 2));
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
    if (receipt.success === false) return "Project service control failed";
    if (
        receipt.success !== true
        || typeof receipt.message !== "string"
        || receipt.message.length > MAX_SERVICE_CONTROL_MESSAGE_LENGTH
    ) {
        return "Project service control response is invalid";
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
