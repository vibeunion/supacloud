import { Type } from "typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import { registerTool, type ToolServer } from "../tool-server";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolResult = ReleaseControlToolResponse;
export type BranchHttpTransport = Pick<HttpTransport, "get" | "post" | "delete">;

interface PromotionPlanEntry {
    version: string;
    name: string | null;
    checksum: string;
    statement_count: number;
    destructive: boolean;
}

interface PromotionPlanBlock {
    code: keyof typeof PROMOTION_BLOCK_MESSAGES;
    version: string;
    name: string | null;
    message: string;
}

interface PromotionPlan {
    mode: "migrations";
    parent_ref: string;
    branch_ref: string;
    safe_to_apply: boolean;
    plan_checksum: string;
    pending: PromotionPlanEntry[];
    applied: PromotionPlanEntry[];
    blocked: PromotionPlanBlock[];
    warnings: string[];
    requires_destructive_confirmation: boolean;
    ignored_branch_data: true;
}

interface PromotionResult {
    promoted: true;
    mode: "migrations";
    project_ref: string;
    branch_ref: string;
    applied: PromotionPlanEntry[];
    plan: PromotionPlan;
    branch_data_copied: false;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROMOTION_PLAN_MAX_JSON_BYTES = 512 * 1024;
const PROMOTION_BLOCK_MESSAGES = {
    parent_ahead: "Parent history is ahead; recreate or rebase the preview branch.",
    checksum_mismatch: "Parent and branch migration checksums differ.",
    stored_checksum_mismatch: "Stored checksum does not match migration SQL.",
    name_conflict: "Migration name already exists in the parent.",
    out_of_order_migration: "Migration precedes the latest parent migration.",
    empty_migration: "Migration has no executable statements.",
    non_transactional_sql: "Migration requires a separate maintenance path.",
    unsupported_sql: "Migration exceeds the project-scoped SQL policy.",
} as const;
const PROMOTION_FAILURE_CODES = new Set([
    "promotion_locked", "promotion_plan_changed", "promotion_blocked",
    "destructive_confirmation_required", "promotion_apply_failed", "promotion_readback_failed",
    "promotion_failed", "promotion_plan_failed", "promotion_plan_required", "branch_not_active",
]);
const PROMOTION_WARNINGS = [
    "Only recorded migrations are promoted; branch data and untracked schema changes are not copied.",
    "Migration SQL can modify parent data and must be reviewed.",
];

function resolveProjectRef(ref: unknown, projectRef?: string): string {
    const resolved = typeof ref === "string" && ref.trim() ? ref.trim() : projectRef || "";
    if (!resolved) throw new Error("'ref' is required for this action");
    return resolved;
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`'${field}' is required`);
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && SHA256_PATTERN.test(value);
}

function parsePromotionEntry(candidate: unknown): PromotionPlanEntry | null {
    if (!isRecord(candidate)) return null;
    const { version, name, checksum, statement_count: statementCount, statements, destructive } = candidate;
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version)) return null;
    if (name !== null && (typeof name !== "string" || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) return null;
    if (!isSha256(checksum)) return null;
    if (typeof statementCount !== "number" || !Number.isSafeInteger(statementCount) || statementCount < 0) return null;
    if (typeof destructive !== "boolean") return null;
    if (statements !== undefined
        && (!Array.isArray(statements) || statements.length !== statementCount
            || statements.some((statement) => typeof statement !== "string"))) {
        return null;
    }
    return {
        version,
        name,
        checksum,
        statement_count: statementCount,
        destructive,
    };
}

function parsePromotionBlock(candidate: unknown): PromotionPlanBlock | null {
    if (!isRecord(candidate)) return null;
    const { code, version, name, message } = candidate;
    if (typeof code !== "string" || !Object.hasOwn(PROMOTION_BLOCK_MESSAGES, code)) return null;
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version)) return null;
    if (name !== null && (typeof name !== "string" || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) return null;
    if (typeof message !== "string") return null;
    const blockCode = code as keyof typeof PROMOTION_BLOCK_MESSAGES;
    return {
        code: blockCode,
        version,
        name,
        message: PROMOTION_BLOCK_MESSAGES[blockCode],
    };
}

function uniqueVersions(entries: readonly PromotionPlanEntry[]): boolean {
    const versions = entries.map((entry) => entry.version);
    return new Set(versions).size === versions.length;
}

function samePromotionEntry(left: PromotionPlanEntry, right: PromotionPlanEntry): boolean {
    return left.version === right.version && left.checksum === right.checksum
        && left.name === right.name && left.statement_count === right.statement_count
        && left.destructive === right.destructive;
}

function parsePromotionPlan(
    candidate: unknown,
    expectedScope: { parentRef: string; branchRef: string },
): PromotionPlan | null {
    if (!isRecord(candidate)) return null;
    const {
        mode,
        parent_ref: parentRef,
        branch_ref: branchRef,
        safe_to_apply: safeToApply,
        plan_checksum: planChecksum,
        pending,
        applied,
        blocked,
        warnings,
        requires_destructive_confirmation: requiresDestructiveConfirmation,
        ignored_branch_data: ignoredBranchData,
    } = candidate;
    if (mode !== "migrations"
        || typeof parentRef !== "string"
        || typeof branchRef !== "string"
        || typeof safeToApply !== "boolean"
        || !isSha256(planChecksum)
        || !Array.isArray(pending)
        || !Array.isArray(applied)
        || !Array.isArray(blocked)
        || !Array.isArray(warnings)
        || typeof requiresDestructiveConfirmation !== "boolean"
        || ignoredBranchData !== true) {
        return null;
    }
    if (parentRef !== expectedScope.parentRef || branchRef !== expectedScope.branchRef) return null;

    const pendingEntries = pending.map(parsePromotionEntry);
    const appliedEntries = applied.map(parsePromotionEntry);
    const blockingFindings = blocked.map(parsePromotionBlock);
    if (pendingEntries.some((entry) => entry === null)
        || appliedEntries.some((entry) => entry === null)
        || blockingFindings.some((entry) => entry === null)
        || warnings.some((warning) => typeof warning !== "string")) {
        return null;
    }
    const normalizedPending = pendingEntries.filter((entry): entry is PromotionPlanEntry => entry !== null);
    const normalizedApplied = appliedEntries.filter((entry): entry is PromotionPlanEntry => entry !== null);
    const normalizedBlocked = blockingFindings.filter((entry): entry is PromotionPlanBlock => entry !== null);
    const hasDestructivePending = normalizedPending.some((entry) => entry.destructive);
    if (!uniqueVersions(normalizedPending)
        || !uniqueVersions(normalizedApplied)
        || !uniqueVersions([...normalizedPending, ...normalizedApplied])
        || normalizedPending.some((entry) => entry.statement_count === 0)
        || safeToApply !== (normalizedBlocked.length === 0)
        || requiresDestructiveConfirmation !== hasDestructivePending) {
        return null;
    }
    return {
        mode,
        parent_ref: parentRef,
        branch_ref: branchRef,
        safe_to_apply: safeToApply,
        plan_checksum: planChecksum,
        pending: normalizedPending,
        applied: normalizedApplied,
        blocked: normalizedBlocked,
        warnings: [...PROMOTION_WARNINGS],
        requires_destructive_confirmation: requiresDestructiveConfirmation,
        ignored_branch_data: true,
    };
}

function parsePromotionResult(
    candidate: unknown,
    expectedScope: { parentRef: string; branchRef: string },
    reviewedPending: readonly PromotionPlanEntry[],
): PromotionResult | null {
    if (!isRecord(candidate)
        || candidate.promoted !== true
        || candidate.mode !== "migrations"
        || candidate.project_ref !== expectedScope.parentRef
        || candidate.branch_ref !== expectedScope.branchRef
        || candidate.branch_data_copied !== false
        || !Array.isArray(candidate.applied)) {
        return null;
    }
    const applied = candidate.applied.map(parsePromotionEntry);
    if (applied.some((entry) => entry === null)) return null;
    const normalizedApplied = applied.filter((entry): entry is PromotionPlanEntry => entry !== null);
    if (!uniqueVersions(normalizedApplied) || normalizedApplied.length !== reviewedPending.length) return null;
    const reviewedByVersion = new Map(reviewedPending.map((entry) => [entry.version, entry]));
    if (normalizedApplied.some((entry) => {
        const reviewed = reviewedByVersion.get(entry.version);
        return !reviewed || !samePromotionEntry(entry, reviewed);
    })) return null;
    const plan = parsePromotionPlan(candidate.plan, expectedScope);
    if (!plan || !plan.safe_to_apply || plan.pending.length > 0) return null;
    const readbackByVersion = new Map(plan.applied.map((entry) => [entry.version, entry]));
    if (normalizedApplied.some((entry) => {
        const readback = readbackByVersion.get(entry.version);
        return !readback || !samePromotionEntry(entry, readback);
    })) return null;
    return {
        promoted: true,
        mode: "migrations",
        project_ref: expectedScope.parentRef,
        branch_ref: expectedScope.branchRef,
        applied: normalizedApplied,
        plan,
        branch_data_copied: false,
    };
}

function safePromotionCode(result: HttpResult<unknown>): string | undefined {
    if (!isRecord(result.data) || typeof result.data.code !== "string") return undefined;
    return PROMOTION_FAILURE_CODES.has(result.data.code) ? result.data.code : undefined;
}

function appliedVersions(result: HttpResult<unknown>): string[] {
    if (result.transportError || result.responseReadError || !isRecord(result.data)
        || !Array.isArray(result.data.applied)) return [];
    const entries = result.data.applied.map(parsePromotionEntry);
    if (entries.some((entry) => !entry)) return [];
    const validated = entries.filter((entry): entry is PromotionPlanEntry => entry !== null);
    return uniqueVersions(validated) ? validated.map((entry) => entry.version) : [];
}

function promotionFailure(
    response: ReleaseControlToolResponse,
    json: boolean,
    unknownOutcome: boolean,
): ToolResult {
    if (json) return response;
    const state: unknown = JSON.parse(response.content[0]!.text);
    if (!isRecord(state) || !isRecord(state.error)) return response;
    const lines = [
        unknownOutcome ? "Promotion outcome is unknown; do not repeat the request automatically." : "Promotion request was not verified.",
        `Error: ${state.error.code}`,
        `Project: ${state.project_ref}; branch: ${state.branch_ref}`,
        ...(typeof state.reason === "string" ? [`Reason: ${state.reason}`] : []),
        ...(state.mutation_sent === false ? ["No promotion request was sent."] : []),
        ...(typeof state.plan_checksum === "string" ? [`Reviewed checksum: ${state.plan_checksum}`] : []),
        ...(Array.isArray(state.reported_applied_versions) && state.reported_applied_versions.length > 0
            ? [`Server-reported applied versions: ${state.reported_applied_versions.join(", ")}`]
            : []),
        "Fetch a fresh promotion_plan and review ledger state before another promote.",
    ];
    return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}

function responseError(result: HttpResult<unknown>): string {
    if (isRecord(result.data)) {
        const message = result.data.error || result.data.message;
        if (typeof message === "string") return message;
    }
    return `Request failed with HTTP ${result.status}`;
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

function formatPromotionResult(response: PromotionResult): string {
    const versions = response.applied.map((entry) => entry.version);
    return [
        `Migration promotion completed: ${response.applied.length} applied.`,
        ...(versions.length > 0 ? [`Versions: ${versions.join(", ")}`] : []),
        "Branch data was not automatically copied to the parent project.",
    ].join("\n");
}

export function registerBranchTools(
    server: ToolServer,
    http: BranchHttpTransport,
    options: { projectRef?: string; readOnly?: boolean } = {},
): void {
    registerTool(server,
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
            json: optional(Type.Boolean(), "[promotion_plan/promote] Return machine-readable JSON"),
        },
        async (args) => {
            const action = requireString(args.action, "action");
            const ref = resolveProjectRef(args.ref, options.projectRef);
            const writeAction = action === "create" || action === "delete" || action === "promote";
            if (writeAction && options.readOnly) {
                return args.json && action === "promote"
                    ? releaseControlFailure("branch.promote", "MUTATION_NOT_SUCCEEDED", null, {
                        project_ref: ref, branch_ref: args.branch_ref, reason: "READ_ONLY",
                    })
                    : readOnlyResult();
            }

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
                const scope = { project_ref: ref, branch_ref: branchRef };
                result = await http.get(`${branchPath(ref, branchRef)}/promote/plan`, {
                    maxJsonBytes: PROMOTION_PLAN_MAX_JSON_BYTES,
                    responseTimeoutMs: 5_000,
                });
                if (!result.ok) {
                    return promotionFailure(releaseControlFailure("branch.promotion_plan", "HTTP_ERROR",
                        result.transportError ? null : result.status, scope), args.json === true, false);
                }
                const plan = parsePromotionPlan(result.data, { parentRef: ref, branchRef });
                if (result.status !== 200 || !plan) {
                    return promotionFailure(releaseControlFailure("branch.promotion_plan", "INVALID_RESPONSE",
                        result.status, scope), args.json === true, false);
                }
                return args.json
                    ? releaseControlSuccess("branch.promotion_plan", { ...scope, plan })
                    : { content: [{ type: "text", text: formatPromotionPlan(plan) }] };
            } else if (action === "promote") {
                const branchRef = requireString(args.branch_ref, "branch_ref");
                const planChecksum = requireString(args.plan_checksum, "plan_checksum");
                if (!isSha256(planChecksum)) throw new Error("'plan_checksum' must be a 64-character lowercase SHA-256 checksum");
                const state = {
                    project_ref: ref,
                    branch_ref: branchRef,
                    plan_checksum: planChecksum,
                    automatic_retry: false,
                    reconciliation: { action: "promotion_plan", ref, branch_ref: branchRef },
                };
                const preflight = await http.get(`${branchPath(ref, branchRef)}/promote/plan`, {
                    maxJsonBytes: PROMOTION_PLAN_MAX_JSON_BYTES,
                    responseTimeoutMs: 5_000,
                });
                const beforeMutation = { ...state, mutation_sent: false };
                if (!preflight.ok) {
                    return promotionFailure(releaseControlFailure("branch.promote", "HTTP_ERROR",
                        preflight.transportError ? null : preflight.status,
                        { ...beforeMutation, reason: "PREFLIGHT_FAILED" }), args.json === true, false);
                }
                const plan = parsePromotionPlan(preflight.data, { parentRef: ref, branchRef });
                if (preflight.status !== 200 || !plan) {
                    return promotionFailure(releaseControlFailure("branch.promote", "INVALID_RESPONSE",
                        preflight.status, { ...beforeMutation, reason: "PREFLIGHT_UNVERIFIED" }),
                        args.json === true, false);
                }
                const preflightReason = plan.plan_checksum !== planChecksum ? "PLAN_CHANGED"
                    : !plan.safe_to_apply ? "PLAN_BLOCKED"
                    : plan.requires_destructive_confirmation && args.confirm_destructive !== true
                        ? "DESTRUCTIVE_CONFIRMATION_REQUIRED" : null;
                if (preflightReason) {
                    return promotionFailure(releaseControlFailure("branch.promote", "MUTATION_NOT_SUCCEEDED",
                        null, { ...beforeMutation, reason: preflightReason, observed_plan_checksum: plan.plan_checksum }),
                        args.json === true, false);
                }
                if (plan.pending.length === 0) {
                    return args.json
                        ? releaseControlSuccess("branch.promote", {
                            ...beforeMutation, promoted: false, unchanged: true, mode: "migrations",
                            applied: [], plan, branch_data_copied: false, reviewed_plan_checksum: planChecksum,
                        })
                        : { content: [{ type: "text", text: "Migration promotion unchanged: no pending migrations; no promotion request sent." }] };
                }
                result = await http.post(`${branchPath(ref, branchRef)}/promote`, {
                    mode: "migrations",
                    plan_checksum: planChecksum,
                    confirm_destructive: args.confirm_destructive === true,
                }, {
                    maxJsonBytes: PROMOTION_PLAN_MAX_JSON_BYTES,
                    responseTimeoutMs: 5_000,
                    timeoutMs: 30_000,
                });
                if (!result.ok) {
                    return promotionFailure(releaseControlMutationFailure("branch.promote", result, {
                        ...state,
                        mutation_sent: true,
                        reported_applied_versions: appliedVersions(result),
                        ...(safePromotionCode(result) ? { server_code: safePromotionCode(result) } : {}),
                    }), args.json === true, result.transportError === true || result.responseReadError === true
                        || result.status === 408 || result.status >= 500);
                }
                const promoted = parsePromotionResult(result.data, { parentRef: ref, branchRef }, plan.pending);
                if (result.status !== 200 || !promoted) {
                    return promotionFailure(releaseControlFailure("branch.promote", "OUTCOME_UNKNOWN",
                        result.status, { ...state, mutation_sent: true }), args.json === true, true);
                }
                return args.json
                    ? releaseControlSuccess("branch.promote", {
                        ...promoted, unchanged: false, mutation_sent: true, reviewed_plan_checksum: planChecksum,
                    })
                    : { content: [{ type: "text", text: formatPromotionResult(promoted) }] };
            } else {
                throw new Error(`Unknown branch action: ${action}`);
            }

            if (!result.ok) {
                return { isError: true, content: [{ type: "text", text: responseError(result) }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
        },
    );
}
