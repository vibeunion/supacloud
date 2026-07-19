import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";

type ToolResult = {
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
};

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => void;
};

interface PromotionPlanEntry {
    version: string;
    name: string | null;
    checksum: string;
    statement_count: number;
    statements?: string[];
    destructive: boolean;
}

interface PromotionPlanBlock {
    code: string;
    version: string;
    name: string | null;
    message: string;
}

interface PromotionPlan {
    mode: "migrations";
    safe_to_apply: boolean;
    plan_checksum: string;
    pending: PromotionPlanEntry[];
    applied: PromotionPlanEntry[];
    blocked: PromotionPlanBlock[];
    warnings: string[];
    requires_destructive_confirmation: boolean;
    ignored_branch_data: boolean;
}

function resolveProjectRef(ref: unknown, projectRef?: string): string {
    const resolved = typeof ref === "string" && ref.trim() ? ref.trim() : projectRef || "";
    if (!resolved) throw new Error("'ref' is required for this action");
    return resolved;
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`'${field}' is required`);
    return value.trim();
}

function responseError(result: HttpResult<unknown>): string {
    if (result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        const message = data.error || data.message;
        if (typeof message === "string") {
            const details = [message];
            if (Array.isArray(data.applied) && data.applied.length > 0) {
                const versions = data.applied
                    .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).version : null)
                    .filter((version): version is string => typeof version === "string");
                details.push(`Applied before failure: ${versions.join(", ") || data.applied.length}`);
                details.push("Fetch a fresh promotion_plan before retrying.");
            }
            if (data.replacement_committed === true) {
                details.push(`Database replacement committed; recovery is required${typeof data.backup_database === "string" ? ` using backup ${data.backup_database}` : ""}.`);
            }
            return details.join("\n");
        }
    }
    return `Request failed with HTTP ${result.status}`;
}

function isPromotionPlan(candidate: unknown): candidate is PromotionPlan {
    if (!candidate || typeof candidate !== "object") return false;
    const plan = candidate as Partial<PromotionPlan>;
    return plan.mode === "migrations"
        && typeof plan.safe_to_apply === "boolean"
        && typeof plan.plan_checksum === "string"
        && Array.isArray(plan.pending)
        && Array.isArray(plan.applied)
        && Array.isArray(plan.blocked)
        && Array.isArray(plan.warnings)
        && typeof plan.requires_destructive_confirmation === "boolean";
}

function projectPath(ref: string): string {
    return `/v1/projects/${encodeURIComponent(ref)}/branches`;
}

function branchPath(ref: string, branchRef: string): string {
    return `${projectPath(ref)}/${encodeURIComponent(branchRef)}`;
}

function formatPromotionPlan(plan: PromotionPlan): string {
    const lines = [
        `Migration promotion plan: ${plan.safe_to_apply ? "READY" : "BLOCKED"}`,
        `Plan checksum: ${plan.plan_checksum}`,
        `Pending: ${plan.pending.length}`,
        `Already applied: ${plan.applied.length}`,
        `Blocked: ${plan.blocked.length}`,
        "Branch data will not be automatically copied to the parent project.",
    ];

    if (plan.pending.length > 0) {
        lines.push("", "Pending migrations:");
        for (const migration of plan.pending) {
            lines.push(
                `  - ${migration.version} ${migration.name || "(unnamed)"}`
                + ` checksum=${migration.checksum.slice(0, 12)}`
                + `${migration.destructive ? " destructive" : ""}`,
            );
        }
    }
    if (plan.blocked.length > 0) {
        lines.push("", "Blocking findings:");
        for (const blocked of plan.blocked) lines.push(`  - [${blocked.code}] ${blocked.message}`);
    }
    if (plan.warnings.length > 0) {
        lines.push("", "Warnings:", ...plan.warnings.map((warning) => `  - ${warning}`));
    }
    if (plan.requires_destructive_confirmation) {
        lines.push("", "Re-run promote with --confirm_destructive true after reviewing destructive SQL.");
    }
    return lines.join("\n");
}

function readOnlyResult(): ToolResult {
    return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Branch write blocked in read-only mode." }],
    };
}

function formatPromotionResult(responseValue: unknown): string {
    if (!responseValue || typeof responseValue !== "object") return "Migrations promoted.";
    const response = responseValue as Record<string, unknown>;
    const applied = Array.isArray(response.applied) ? response.applied : [];
    const versions = applied
        .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).version : null)
        .filter((version): version is string => typeof version === "string");
    return [
        `Migration promotion completed: ${applied.length} applied.`,
        ...(versions.length > 0 ? [`Versions: ${versions.join(", ")}`] : []),
        "Branch data was not automatically copied to the parent project.",
    ].join("\n");
}

export function registerBranchTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectRef?: string; readOnly?: boolean } = {},
): void {
    server.tool(
        "branch",
        "Preview branch lifecycle and safe migration promotion. Whole-database replacement is intentionally not exposed by this project CLI.",
        {
            action: withDescription(stringEnum([
                "list", "create", "delete", "promotion_plan", "promote",
            ]), "Action to perform"),
            ref: optional(Type.String(), "[*] Optional parent project override"),
            branch_ref: optional(Type.String(), "[delete/promotion_plan/promote] Preview branch ref"),
            name: optional(Type.String(), "[create] Branch name"),
            data_mode: optional(stringEnum(["schema_only", "full_clone"]), "[create] Preview data mode (default: schema_only)"),
            plan_checksum: optional(Type.String(), "[promote] Reviewed plan checksum from promotion_plan"),
            confirm_destructive: optional(Type.Boolean(), "[promote] Confirm reviewed destructive migrations"),
        },
        async (args) => {
            const action = requireString(args.action, "action");
            const ref = resolveProjectRef(args.ref, options.projectRef);
            const writeAction = action === "create" || action === "delete" || action === "promote";
            if (writeAction && options.readOnly) return readOnlyResult();

            let result: HttpResult<unknown>;
            if (action === "list") {
                result = await http.get(projectPath(ref));
            } else if (action === "create") {
                const name = requireString(args.name, "name");
                result = await http.post(projectPath(ref), {
                    name,
                    data_mode: args.data_mode === "full_clone" ? "full_clone" : "schema_only",
                });
            } else if (action === "delete") {
                const branchRef = requireString(args.branch_ref, "branch_ref");
                result = await http.delete(branchPath(ref, branchRef));
            } else if (action === "promotion_plan") {
                const branchRef = requireString(args.branch_ref, "branch_ref");
                result = await http.get(`${branchPath(ref, branchRef)}/promote/plan`);
                if (result.ok && isPromotionPlan(result.data)) {
                    return { content: [{ type: "text", text: formatPromotionPlan(result.data) }] };
                }
            } else if (action === "promote") {
                const branchRef = requireString(args.branch_ref, "branch_ref");
                const planChecksum = requireString(args.plan_checksum, "plan_checksum");
                result = await http.post(`${branchPath(ref, branchRef)}/promote`, {
                    mode: "migrations",
                    plan_checksum: planChecksum,
                    confirm_destructive: args.confirm_destructive === true,
                });
            } else {
                throw new Error(`Unknown branch action: ${action}`);
            }

            if (!result.ok) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `❌ ${responseError(result)}` }],
                };
            }
            if (action === "promote") {
                return { content: [{ type: "text", text: formatPromotionResult(result.data) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
        },
    );
}
