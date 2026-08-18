import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    discardPreparedProjectEnvFile,
    parseProjectCreateCredentials,
    parseProjectCreateIdentity,
    parseProjectCreateWithoutCredentials,
    prepareProjectEnvFile,
    ProjectCreateEnvError,
    writeProjectEnvFile,
    type CredentialFileState,
    type ProjectCreateCredentials,
    type ProjectCreateIdentity,
    type ProjectEnvironment,
    type ProjectEnvFileOperations,
    type PreparedProjectEnvFile,
} from "./project-create-env";
import {
    PROJECT_READ_RESPONSE_MAX_BYTES,
    projectGetRead,
    projectListRead,
    type ProjectReadResult,
} from "./project-read-projection";
import { projectEndpointListRead, projectEndpointsRead } from "./project-endpoint-projection";
import { parseProjectRuntimeSnapshot } from "./project-runtime-snapshot";

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
const AUTH_SERVICE_HOST_SUFFIX = "-auth";
const SAFE_PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const SAFE_AUTHORITY_PROJECT_REF = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_SERVICE_CONTROL_MESSAGE_LENGTH = 256;
const MAX_RUNTIME_SNAPSHOT_BYTES = 64 * 1024;
const RELEASE_CONTROL_RESPONSE_SCHEMA = "supacloud.cli.release-control.v1";
const PROJECT_CREATE_OPERATION = "project.create";
const PROJECT_ENVIRONMENTS = ["test", "production"] as const satisfies readonly ProjectEnvironment[];
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

function projectReadResponse(readResult: ProjectReadResult): ProjectToolResponse {
    const response = projectToolResponse(readResult.text);
    return readResult.isError ? { ...response, isError: true } : response;
}

function failedProjectServiceResponse(message: string): ProjectToolResponse {
    return {
        content: [{ type: "text", text: `❌ ${message}` }],
        isError: true,
    };
}

function projectCreateReceipt(payload: Record<string, unknown>): ProjectToolResponse {
    return {
        content: [{ type: "text", text: JSON.stringify({
            schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
            ...payload,
        }, null, 2) }],
    };
}

function projectCreateErrorReceipt(payload: Record<string, unknown>): ProjectToolResponse {
    return { ...projectCreateReceipt(payload), isError: true };
}

function projectCreateFailure(
    code: string,
    httpStatus: number | null,
): ProjectToolResponse {
    return projectCreateErrorReceipt({
        ok: false,
        operation: PROJECT_CREATE_OPERATION,
        error: { code, http_status: httpStatus },
    });
}

function projectCreateMutationFailure(response: HttpResult<unknown>): ProjectToolResponse {
    const outcomeUnknown = response.transportError || response.status === 408 || response.status >= 500;
    return outcomeUnknown
        ? projectCreateFailure("OUTCOME_UNKNOWN", response.transportError ? null : response.status)
        : projectCreateFailure("HTTP_ERROR", response.status);
}

function isCompleteApiHostname(hostname: string): boolean {
    if (hostname === "localhost") return true;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
        return hostname.split(".").every(octet => Number(octet) <= 255);
    }
    if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
    const labels = hostname.split(".");
    return labels.length >= 2 && labels.every(label => DNS_LABEL.test(label));
}

function normalizedApiDomain(candidate?: string): string | undefined {
    const normalized = candidate?.trim().toLowerCase();
    if (!normalized || normalized.length > 253 || /[\s/@?#]/.test(normalized)) return undefined;
    try {
        const parsed = new URL(`https://${normalized}`);
        const exactHostname = parsed.hostname === normalized && !parsed.port;
        return exactHostname && isCompleteApiHostname(normalized) ? normalized : undefined;
    } catch {
        return undefined;
    }
}

function canonicalProjectApiOrigin(hostname: string): string {
    const loopback = hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "[::1]";
    return new URL(`${loopback ? "http" : "https"}://${hostname}`).origin;
}

function expectedProjectApiOrigin(domain?: string, apiDomain?: string): string | undefined {
    if (apiDomain) {
        const normalizedApi = normalizedApiDomain(apiDomain);
        return normalizedApi ? canonicalProjectApiOrigin(normalizedApi) : undefined;
    }
    const normalizedDomain = normalizedApiDomain(domain);
    if (!normalizedDomain) return undefined;
    const hostname = normalizedDomain.startsWith("api.")
        ? normalizedDomain
        : `api.${normalizedDomain}`;
    return canonicalProjectApiOrigin(hostname);
}

function projectCreateEnvironment(candidate: unknown): ProjectEnvironment | undefined {
    return candidate === "test" || candidate === "production" ? candidate : undefined;
}

interface ProjectCreateResponseBinding {
    projectName: string;
    apiOrigin?: string;
}

function projectCreateFileFailure(
    identity: ProjectCreateIdentity,
    credentialFileState: CredentialFileState,
    code: string,
    httpStatus: number,
): ProjectToolResponse {
    return projectCreateErrorReceipt({
        ok: false,
        operation: PROJECT_CREATE_OPERATION,
        project_ref: identity.projectRef,
        api_url: identity.apiUrl,
        remote_created: true,
        credential_file_state: credentialFileState,
        ...(credentialFileState === "absent" ? { credentials_written: false } : {}),
        retry_safe: false,
        error: { code, http_status: httpStatus },
    });
}

async function writeCreatedProjectEnv(
    preparedEnvFile: PreparedProjectEnvFile,
    credentials: ProjectCreateCredentials,
    responseStatus: number,
    fileOperations?: ProjectEnvFileOperations,
): Promise<ProjectToolResponse | null> {
    try {
        await writeProjectEnvFile(preparedEnvFile, credentials, fileOperations);
        return null;
    } catch (error: unknown) {
        const code = error instanceof ProjectCreateEnvError
            ? error.code
            : "ENV_FILE_WRITE_FAILED";
        if (!(error instanceof ProjectCreateEnvError) || error.credentialFileState === "unknown") {
            return projectCreateFileFailure(credentials, "unknown", code, responseStatus);
        }
        return projectCreateFileFailure(credentials, "absent", code, responseStatus);
    }
}

function successfulProjectCreate(
    identity: ProjectCreateIdentity,
    preparedEnvFile?: PreparedProjectEnvFile,
): ProjectToolResponse {
    return projectCreateReceipt({
        ok: true,
        operation: PROJECT_CREATE_OPERATION,
        project_ref: identity.projectRef,
        api_url: identity.apiUrl,
        credentials_written: Boolean(preparedEnvFile),
        ...(preparedEnvFile ? {
            env_file: preparedEnvFile.path,
            env_file_scope: "project_application",
        } : {}),
    });
}

function invalidProjectCreateResponse(
    responsePayload: unknown,
    responseStatus: number,
    expectedApiOrigin?: string,
): ProjectToolResponse {
    const identity = parseProjectCreateIdentity(responsePayload, expectedApiOrigin);
    return identity
        ? projectCreateFileFailure(identity, "absent", "INVALID_RESPONSE", responseStatus)
        : projectCreateFailure("OUTCOME_UNKNOWN", responseStatus);
}

function projectCreateWithoutEnvResponse(
    response: HttpResult<unknown>,
    expectedApiOrigin?: string,
): ProjectToolResponse {
    const identity = parseProjectCreateWithoutCredentials(response.data, expectedApiOrigin);
    return identity
        ? successfulProjectCreate(identity)
        : invalidProjectCreateResponse(response.data, response.status, expectedApiOrigin);
}

async function discardProjectEnvReservation(
    preparedEnvFile: PreparedProjectEnvFile,
    response: HttpResult<unknown>,
    expectedApiOrigin: string | undefined,
    fileOperations?: ProjectEnvFileOperations,
): Promise<ProjectToolResponse | null> {
    const credentialFileState = await discardPreparedProjectEnvFile(preparedEnvFile, fileOperations);
    if (credentialFileState === "absent") return null;
    const identity = parseProjectCreateIdentity(response.data, expectedApiOrigin);
    return identity
        ? projectCreateFileFailure(identity, "unknown", "ENV_FILE_CLEANUP_FAILED", response.status)
        : projectCreateFailure("ENV_FILE_CLEANUP_FAILED", response.status);
}

async function projectCreateWithEnvResponse(
    response: HttpResult<unknown>,
    preparedEnvFile: PreparedProjectEnvFile,
    binding: ProjectCreateResponseBinding,
    fileOperations?: ProjectEnvFileOperations,
): Promise<ProjectToolResponse> {
    const credentials = parseProjectCreateCredentials(
        response.data,
        binding.apiOrigin,
        binding.projectName,
    );
    if (!credentials) {
        const cleanupFailure = await discardProjectEnvReservation(
            preparedEnvFile,
            response,
            binding.apiOrigin,
            fileOperations,
        );
        return cleanupFailure
            ?? invalidProjectCreateResponse(response.data, response.status, binding.apiOrigin);
    }
    const writeFailure = await writeCreatedProjectEnv(
        preparedEnvFile,
        credentials,
        response.status,
        fileOperations,
    );
    return writeFailure ?? successfulProjectCreate(credentials, preparedEnvFile);
}

async function projectCreateResponse(
    response: HttpResult<unknown>,
    preparedEnvFile: PreparedProjectEnvFile | undefined,
    binding: ProjectCreateResponseBinding,
    fileOperations?: ProjectEnvFileOperations,
): Promise<ProjectToolResponse> {
    if (!response.ok || response.status !== 201) {
        if (preparedEnvFile) {
            const cleanupFailure = await discardProjectEnvReservation(
                preparedEnvFile,
                response,
                binding.apiOrigin,
                fileOperations,
            );
            if (cleanupFailure) return cleanupFailure;
        }
        return response.ok
            ? projectCreateFailure("OUTCOME_UNKNOWN", response.status)
            : projectCreateMutationFailure(response);
    }
    return preparedEnvFile
        ? projectCreateWithEnvResponse(
            response,
            preparedEnvFile,
            binding,
            fileOperations,
        )
        : projectCreateWithoutEnvResponse(response, binding.apiOrigin);
}

function failedProjectServiceHttpResponse(response: HttpResult<unknown>): ProjectToolResponse {
    if (
        response.status === 409
        && isRecordPayload(response.data)
        && response.data.code === AUTH_RUNTIME_MANAGED_BY_OWNER
        && typeof response.data.authority_project_ref === "string"
        && SAFE_AUTHORITY_PROJECT_REF.test(response.data.authority_project_ref)
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
    if (serviceId === "auth") {
        if (!hostIds[0].endsWith(AUTH_SERVICE_HOST_SUFFIX)) return false;
        return SAFE_AUTHORITY_PROJECT_REF.test(hostIds[0].slice(0, -AUTH_SERVICE_HOST_SUFFIX.length));
    }
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

function projectRuntimeSnapshotResponse(
    projectRef: string,
    response: HttpResult<unknown>,
): ProjectToolResponse {
    if (response.responseError) {
        return failedProjectServiceResponse("Project runtime snapshot response is invalid");
    }
    if (!response.ok) return failedProjectServiceHttpResponse(response);
    const snapshot = parseProjectRuntimeSnapshot(response.data, projectRef);
    return snapshot
        ? projectToolResponse(JSON.stringify(snapshot, null, 2))
        : failedProjectServiceResponse("Project runtime snapshot response is invalid");
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
                    return projectReadResponse(projectGetRead(
                        await http.get(`/v1/projects/${resolvedRef}`, {
                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,
                        }),
                        resolvedRef,
                    ));
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

export function registerAdminProjectCliTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectEnvFileOperations?: ProjectEnvFileOperations } = {},
): void {
    const fileOperations = options.projectEnvFileOperations;
    server.tool(
        "project",
        "Platform-level project lifecycle management. Actions: list, list_endpoints, create, get, endpoints, delete, pause, restore, restart, settings, update_settings, api_keys, health, logs, tasks, services, runtime_snapshot, service_control",
        {
            action: withDescription(stringEnum([
                "list", "list_endpoints", "create", "get", "endpoints", "delete", "pause", "restore",
                "restart", "settings", "update_settings", "api_keys",
                "health", "logs", "tasks", "services", "runtime_snapshot", "service_control",
            ]), "Action to perform"),
            ref: optional(Type.String(), "[*] Project ref (required for most actions except 'list', 'list_endpoints', and 'create')"),
            name: optional(Type.String(), "[create] Project name"),
            region: optional(Type.String(), "[create] Region (default: local)"),
            organization_id: optional(Type.String(), "[create] Organization ID"),
            domain: optional(Type.String(), "[create] Base custom domain"),
            api_domain: optional(Type.String(), "[create] Explicit API domain"),
            auth_domain: optional(Type.String(), "[create] Explicit Auth/OIDC domain"),
            studio_domain: optional(Type.String(), "[create] Explicit Studio domain"),
            env_file: optional(
                Type.String(),
                "[create] Linux-only absolute new application env path for parent-bound service-role delivery (0600)",
            ),
            environment: optional(
                stringEnum(PROJECT_ENVIRONMENTS),
                "[create] Required with env_file; application credential environment",
            ),
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
            env_file,
            environment,
            settings,
            log_type,
            service,
            service_action,
        }) => {
            let text: string;

            switch (action) {
                case "list":
                    return projectReadResponse(projectListRead(await http.get("/v1/projects", {
                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,
                    })));
                case "list_endpoints":
                    return projectReadResponse(projectEndpointListRead(await http.get("/v1/projects/endpoints", {
                        maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,
                    })));
                case "create": {
                    if (!name) throw new Error("'name' is required for create");
                    const boundApiOrigin = expectedProjectApiOrigin(domain, api_domain);
                    if (env_file && !boundApiOrigin) {
                        return projectCreateFailure("API_DOMAIN_BINDING_REQUIRED", null);
                    }
                    let preparedEnvFile: PreparedProjectEnvFile | undefined;
                    if (env_file) {
                        const boundEnvironment = projectCreateEnvironment(environment);
                        if (!boundEnvironment) {
                            return projectCreateFailure("ENVIRONMENT_BINDING_REQUIRED", null);
                        }
                        try {
                            preparedEnvFile = await prepareProjectEnvFile(
                                env_file,
                                boundEnvironment,
                                fileOperations,
                            );
                        } catch (error: unknown) {
                            const code = error instanceof ProjectCreateEnvError
                                ? error.code
                                : "ENV_FILE_PATH_INVALID";
                            return projectCreateFailure(code, null);
                        }
                    }
                    const createRequest: Record<string, string | undefined> = {
                        name,
                        region: region || "local",
                        organization_id,
                    };
                    if (domain) createRequest.domain = domain;
                    if (api_domain) createRequest.api_domain = api_domain;
                    if (auth_domain) createRequest.auth_domain = auth_domain;
                    if (studio_domain) createRequest.studio_domain = studio_domain;
                    if (preparedEnvFile) createRequest.credential_delivery = "response";
                    return projectCreateResponse(
                        await http.post("/v1/projects", createRequest),
                        preparedEnvFile,
                        { projectName: name, apiOrigin: boundApiOrigin },
                        fileOperations,
                    );
                }
                case "get": {
                    const resolvedRef = resolveRef(ref);
                    return projectReadResponse(projectGetRead(
                        await http.get(`/v1/projects/${resolvedRef}`, {
                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,
                        }),
                        resolvedRef,
                    ));
                }
                case "endpoints": {
                    const resolvedRef = resolveRef(ref);
                    return projectReadResponse(projectEndpointsRead(
                        await http.get(`/v1/projects/${resolvedRef}/endpoints`, {
                            maxResponseBytes: PROJECT_READ_RESPONSE_MAX_BYTES,
                        }),
                        resolvedRef,
                    ));
                }
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
                case "runtime_snapshot": {
                    const resolvedRef = resolveRef(ref);
                    return projectRuntimeSnapshotResponse(
                        resolvedRef,
                        await http.get(
                            `/v1/projects/${encodeURIComponent(resolvedRef)}/runtime-snapshot`,
                            { maxJsonBytes: MAX_RUNTIME_SNAPSHOT_BYTES },
                        ),
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
