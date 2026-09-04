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
    deploy: { write: ["deploy"] },
    project: {
        read: ["get", "endpoints", "health", "logs", "api_keys", "settings", "tasks", "task_detail", "task_stats", "dlq", "background_settings"],
        write: ["pause", "restore", "task_cancel", "task_retry", "update_background_settings"],
        local: ["list"],
    },
    database: {
        read: ["list_tables", "describe_columns", "list_indexes", "list_constraints", "list_extensions", "rls_status", "rls_policies", "list_auth_users", "get_auth_user", "connections", "stats", "slow_queries", "list_migrations", "migration_inventory", "project_url", "generate_types", "database_lint", "db_lint", "rpc_catalog", "list_rpcs"],
        local: ["lint_migrations", "lint"],
        write: ["query", "execute", "apply_migration", "push_migrations", "baseline_migrations", "create_table_rls"],
    },
    supabase: {
        local: ["version", "migration_new", "db_diff", "db_reset", "db_pull", "db_dump", "migration_list", "gen_types"],
        write: ["push"],
    },
    lite: {
        local: [
            "version", "start", "migrate", "status", "keys", "gen_types", "db_reset", "db_diff", "db_pull",
            "snapshot_create", "snapshot_restore", "upgrade", "inspect", "doctor",
        ],
    },
    auth: {
        read: ["list_users", "get_user", "list_providers", "get_provider", "supported_providers", "get_settings", "get_config", "get_oauth_server"],
        write: ["generate_link", "configure_provider", "update_provider", "disable_provider", "wechat_mini", "wechat_open", "update_settings", "update_config", "migrate_oauth_server"],
    },
    oauth_clients: {
        read: ["list", "get"],
        write: ["create", "delete"],
    },
    storage: {
        read: ["status", "list_buckets", "get_bucket", "list_files"],
        write: ["create_bucket", "update_bucket", "delete_bucket", "upload_base64", "delete_file"],
    },
    edge_functions: {
        read: ["list", "get_config", "source"],
        local: ["check", "scaffold"],
        write: ["deploy", "deploy_bundle", "config", "activate", "delete"],
    },
    scheduled_functions: { read: ["list", "get"], write: ["create", "update", "delete"] },
    mutations: { read: ["status"] },
    release: {
        read: ["logical_backup_list", "postgrest_status"],
        write: ["logical_backup_create", "logical_backup_restore", "postgrest_restart", "release_canary_fixture_stage_replay", "release_canary_fixture_disable_replay"],
    },
    secrets: { read: ["list"], write: ["upsert", "delete"] },
    frontend: {
        read: ["list", "get", "build_logs", "list_frameworks", "list_records", "list_releases", "get_release"],
        write: ["create", "update", "delete", "deploy_git", "deploy_upload", "redeploy", "add_domain", "remove_domain", "set_env", "upload_release", "activate_release"],
    },
    task_events: { read: ["inspect_webhook"], write: ["register_webhook", "unregister_webhook"] },
    diagnostics: { read: ["list_checks", "get_run"], write: ["run_checks", "repair"] },
    gateway: {
        read: ["routes", "get_certificate", "custom_hostname"],
        write: ["upsert_route", "update_route", "delete_route", "config", "update_certificate", "issue_certificate", "deploy_certificate", "rebuild", "set_custom_hostname", "delete_custom_hostname", "verify_custom_hostname"],
    },
    branch: { read: ["list", "promotion_plan"], write: ["create", "delete", "promote"] },
    queue: {
        read: ["list", "stats", "list_messages", "dlq", "get_message", "get_settings"],
        write: ["send", "receive", "ack", "release", "fail", "retry", "delete_message", "update_settings"],
    },
    ai: { local: ["show_skill", "install_skill"] },
    app: { local: ["generate", "compile", "check", "graph", "explain", "export-tools"] },
    db: { local: ["lint", "explain"], read: ["module_check"] },
    dev: { read: ["status"], write: ["sync", "watch", "migrate"] },
};

export interface ExecutionAuthorization {
    context: ResolvedContext;
    confirmProduction?: string;
}

interface ToolCatalogEntry {
    schema: ToolSchema;
}

function declaredMode(moduleName: string, action: string): ExecutionMode | undefined {
    const policy = ACTION_POLICY[moduleName];
    if (!policy) return undefined;
    for (const mode of ["read", "write", "local"] as const) {
        if (policy[mode]?.includes(action)) return mode;
    }
    return undefined;
}

export function executionMode(moduleName: string, action: string, args: Record<string, unknown>): ExecutionMode | undefined {
    if (moduleName === "deploy" && args.dry_run === true) return "read";
    if (moduleName === "database"
        && ["push_migrations", "baseline_migrations"].includes(action)
        && args.dry_run === true) return "read";
    if (moduleName === "supabase" && action === "push" && args.dry_run === true) return "read";
    if (moduleName === "dev" && action === "migrate" && args.apply !== true) return "read";
    return declaredMode(moduleName, action);
}

export function authorizeExecution(
    moduleName: string,
    args: Record<string, unknown>,
    authorization: ExecutionAuthorization,
): void {
    const action = typeof args.action === "string" ? args.action : moduleName === "deploy" ? "deploy" : "";
    if (!action) return;
    const mode = executionMode(moduleName, action, args);
    const { context, confirmProduction } = authorization;

    if (!mode && (context.production || context.readOnly)) {
        throw new Error(`Execution policy has no classification for ${moduleName}.${action}`);
    }
    if (context.production
        && mode === "read"
        && typeof args.ref === "string"
        && args.ref
        && args.ref !== context.projectRef) {
        throw new Error("Production profiles cannot target a different project with --ref");
    }
    if (mode !== "write") return;
    if (context.production && moduleName === "diagnostics" && action === "repair") {
        throw new Error("diagnostics repair is forbidden in production environments");
    }
    if (context.readOnly) {
        throw new Error(`Remote write ${moduleName}.${action} is blocked in read-only mode (SUPACLOUD_READ_ONLY=true)`);
    }
    if (!context.production) return;

    const requestedRef = args.ref ?? context.projectRef;
    if (typeof requestedRef !== "string" || !requestedRef) {
        throw new Error(`Production write ${moduleName}.${action} requires a project ref`);
    }
    if (requestedRef !== context.projectRef) {
        throw new Error("Production profiles cannot target a different project with --ref");
    }
    if (confirmProduction !== context.projectRef || confirmProduction !== requestedRef) {
        throw new Error(`Production write requires --confirm-production ${context.projectRef}`);
    }
}

export function validateExecutionPolicyCoverage(tools: Record<string, ToolCatalogEntry>): void {
    for (const [moduleName, tool] of Object.entries(tools)) {
        const actionSchema = schemaProperties(tool.schema).action;
        if (!actionSchema) continue;
        const actions = schemaEnumValues(actionSchema);
        for (const action of actions) {
            if (!declaredMode(moduleName, String(action))) {
                throw new Error(`Execution policy has no classification for ${moduleName}.${String(action)}`);
            }
        }
    }
}
