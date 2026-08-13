import { schemaEnumValues, schemaProperties } from "./schema";
import type { ToolSchema } from "./schema";
import type { ResolvedContext } from "./context";

export type ExecutionMode = "read" | "write" | "local";

interface ModulePolicy {
    read?: readonly string[];
    write?: readonly string[];
    local?: readonly string[];
}

const ACTION_POLICY: Record<string, ModulePolicy> = {
    project: {
        read: [
            "list", "get", "settings", "api_keys", "health", "logs", "tasks", "services", "runtime_snapshot",
        ],
        write: ["create", "delete", "pause", "restore", "restart", "update_settings"],
    },
    platform: {
        read: ["metrics", "list_backups", "list_logical_backups", "network", "list_orgs", "get_org"],
        write: ["create_backup", "create_logical_backup", "restore_logical_backup", "update_network"],
    },
    gateway: {
        read: ["routes", "get_certificate", "custom_hostname"],
        write: [
            "upsert_route", "update_route", "delete_route", "config",
            "update_certificate", "issue_certificate", "deploy_certificate", "rebuild",
            "set_custom_hostname", "delete_custom_hostname", "verify_custom_hostname",
        ],
    },
    frontend: {
        read: ["list_releases", "get_release"],
        write: ["upload_release", "activate_release"],
    },
    ssh: {
        read: [
            "ping", "versions", "diagnose", "exec", "troubleshoot", "container_logs",
            "tenant_list", "tenant_inspect", "tenant_diagnose",
        ],
        write: ["setup", "install", "upgrade", "tenant_migrate"],
    },
};

const DYNAMIC_ACTION_FIELDS: Record<string, string> = {
    "project.service_control": "service_action",
    "ssh.tenant_manage": "tenant_action",
};

const REFLESS_WRITE_ACTIONS = new Set([
    "project.create",
    "ssh.setup",
    "ssh.install",
    "ssh.upgrade",
]);
const SSH_PROJECT_REF_ACTIONS = new Set(["tenant_manage", "tenant_inspect", "tenant_diagnose"]);
const PLATFORM_PROJECT_REF_ACTIONS = new Set([
    "list_backups", "create_backup",
    "list_logical_backups", "create_logical_backup", "restore_logical_backup",
    "network", "update_network",
]);

export interface ExecutionAuthorization {
    context: ResolvedContext;
    confirmProduction?: string;
}

interface ToolCatalogEntry {
    schema: ToolSchema;
}

interface WriteAuthorizationRequest {
    moduleName: string;
    action: string;
    args: Record<string, unknown>;
    projectRef: string | null;
    authorization: ExecutionAuthorization;
}

function declaredMode(moduleName: string, action: string): ExecutionMode | undefined {
    const policy = ACTION_POLICY[moduleName];
    if (!policy) return undefined;
    for (const mode of ["read", "write", "local"] as const) {
        if (policy[mode]?.includes(action)) return mode;
    }
    return undefined;
}

function serviceControlMode(serviceAction: unknown): ExecutionMode | undefined {
    if (serviceAction === "status") return "read";
    if (["start", "stop", "restart", "pause", "resume"].includes(String(serviceAction))) {
        return "write";
    }
    return undefined;
}

export function executionMode(
    moduleName: string,
    action: string,
    args: Record<string, unknown>,
): ExecutionMode | undefined {
    if (moduleName === "project" && action === "service_control") {
        return serviceControlMode(args.service_action);
    }
    if (moduleName === "ssh" && action === "tenant_manage") {
        return serviceControlMode(args.tenant_action);
    }
    return declaredMode(moduleName, action);
}

function stringArgument(args: Record<string, unknown>, field: string): string | null {
    const candidate = args[field];
    return typeof candidate === "string" && candidate ? candidate : null;
}

function sshRequestedProjectRef(action: string, args: Record<string, unknown>): string | null {
    if (action === "tenant_migrate") return stringArgument(args, "target_ref");
    return SSH_PROJECT_REF_ACTIONS.has(action) ? stringArgument(args, "project_ref") : null;
}

function requestedProjectRef(
    moduleName: string,
    action: string,
    args: Record<string, unknown>,
): string | null {
    if (moduleName === "ssh") return sshRequestedProjectRef(action, args);
    if (moduleName === "project") {
        return ["list", "create"].includes(action) ? null : stringArgument(args, "ref");
    }
    if (moduleName === "platform") {
        return PLATFORM_PROJECT_REF_ACTIONS.has(action) ? stringArgument(args, "ref") : null;
    }
    return ["gateway", "frontend"].includes(moduleName) ? stringArgument(args, "ref") : null;
}

function requiresProjectRef(moduleName: string, action: string): boolean {
    return !REFLESS_WRITE_ACTIONS.has(`${moduleName}.${action}`);
}

function apiConfirmationTarget(context: ResolvedContext): string {
    if (!context.apiUrl) {
        throw new Error("Production platform write requires a configured SUPACLOUD_API_URL");
    }
    return `platform:${new URL(context.apiUrl).host}`;
}

function sshConfirmationTarget(context: ResolvedContext): string {
    if (!context.host) {
        throw new Error("Production SSH write requires a configured SUPACLOUD_HOST");
    }
    const portSuffix = context.sshPort === 22 ? "" : `:${context.sshPort}`;
    return `host:${context.host}${portSuffix}`;
}

function productionConfirmationTarget(
    moduleName: string,
    action: string,
    args: Record<string, unknown>,
    context: ResolvedContext,
): string {
    const projectRef = requestedProjectRef(moduleName, action, args);
    if (projectRef) return projectRef;
    if (moduleName === "ssh") return sshConfirmationTarget(context);
    return apiConfirmationTarget(context);
}

function assertProfileProjectBoundary(requestedRef: string | null, context: ResolvedContext): void {
    if (requestedRef && context.projectRef && requestedRef !== context.projectRef) {
        throw new Error("Production profiles cannot target a different project ref");
    }
}

function requiredProjectRefFlag(moduleName: string, action: string): string {
    if (moduleName !== "ssh") return "ref";
    return action === "tenant_migrate" ? "target_ref" : "project_ref";
}

function authorizeWrite(request: WriteAuthorizationRequest): void {
    const { moduleName, action, args, projectRef, authorization } = request;
    const { context, confirmProduction } = authorization;
    if (context.readOnly) {
        throw new Error(`Remote write ${moduleName}.${action} is blocked in read-only mode (SUPACLOUD_READ_ONLY=true)`);
    }
    if (!context.environment) {
        throw new Error(`Remote write ${moduleName}.${action} requires an explicit SUPACLOUD_ENV`);
    }
    if (!context.production) return;
    if (requiresProjectRef(moduleName, action) && !projectRef) {
        throw new Error(
            `Production write ${moduleName}.${action} requires --${requiredProjectRefFlag(moduleName, action)}`,
        );
    }
    const confirmationTarget = productionConfirmationTarget(moduleName, action, args, context);
    if (confirmProduction !== confirmationTarget) {
        throw new Error(`Production write requires --confirm-production ${confirmationTarget}`);
    }
}

function assertKnownMode(
    moduleName: string,
    action: string,
    mode: ExecutionMode | undefined,
    context: ResolvedContext,
): void {
    if (!mode && (context.production || context.readOnly)) {
        throw new Error(`Execution policy has no classification for ${moduleName}.${action}`);
    }
}

export function authorizeExecution(
    moduleName: string,
    args: Record<string, unknown>,
    authorization: ExecutionAuthorization,
): void {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return;
    const mode = executionMode(moduleName, action, args);
    const { context } = authorization;
    assertKnownMode(moduleName, action, mode, context);
    if (!mode) return;

    const projectRef = requestedProjectRef(moduleName, action, args);
    if (context.production) assertProfileProjectBoundary(projectRef, context);
    if (mode !== "write") return;
    authorizeWrite({ moduleName, action, args, projectRef, authorization });
}

function validateDynamicAction(tool: ToolCatalogEntry, moduleName: string, action: string, field: string): void {
    const fieldSchema = schemaProperties(tool.schema)[field];
    const fieldActions = fieldSchema ? schemaEnumValues(fieldSchema) : [];
    if (fieldActions.length === 0) {
        throw new Error(`Execution policy cannot inspect ${moduleName}.${action}.${field}`);
    }
    for (const fieldAction of fieldActions) {
        if (!executionMode(moduleName, action, { [field]: fieldAction })) {
            throw new Error(`Execution policy has no classification for ${moduleName}.${action}.${fieldAction}`);
        }
    }
}

function validateRegisteredAction(tool: ToolCatalogEntry, moduleName: string, action: string): void {
    const dynamicField = DYNAMIC_ACTION_FIELDS[`${moduleName}.${action}`];
    if (dynamicField) return validateDynamicAction(tool, moduleName, action, dynamicField);
    if (!declaredMode(moduleName, action)) {
        throw new Error(`Execution policy has no classification for ${moduleName}.${action}`);
    }
}

export function validateExecutionPolicyCoverage(tools: Record<string, ToolCatalogEntry>): void {
    for (const [moduleName, tool] of Object.entries(tools)) {
        const actionSchema = schemaProperties(tool.schema).action;
        if (!actionSchema) continue;
        const registeredActions = schemaEnumValues(actionSchema);
        if (registeredActions.length === 0) {
            throw new Error(`Execution policy cannot inspect ${moduleName}.action`);
        }
        for (const action of registeredActions) validateRegisteredAction(tool, moduleName, action);
    }
}
