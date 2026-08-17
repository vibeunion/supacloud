import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import { releaseControlFailure, releaseControlSuccess, type ReleaseControlToolResponse } from "./release-control-response";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

type ReleaseOperation =
    | "release.logical_backup.list"
    | "release.logical_backup.create"
    | "release.postgrest.status"
    | "release.postgrest.restart";

type VerifiedLogicalBackup = {
    backup_id: string;
    project_ref: string;
    database: string;
    kind: "logical-full";
    created_at: string;
    completed_at: string;
    bytes: number;
    sha256: string;
};

type ReleasePostgrestStatus = {
    desired: "running" | "stopped";
    actual: "running" | "stopped" | "starting" | "error";
    health: "healthy" | "unhealthy" | "unknown";
};

const SAFE_PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID = /^logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DATABASE = /^[^\u0000-\u001f\u007f]{1,128}$/;
const INVENTORY_MAX_BYTES = 1024 * 1024;
const MUTATION_MAX_BYTES = 64 * 1024;
const BACKUP_TIMEOUT_MS = 36 * 60_000;
const RELEASE_READ_RESPONSE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validProjectRef(ref: string): boolean {
    return SAFE_PROJECT_REF.test(ref);
}

function backupBelongsToProject(backupId: string, projectRef: string): boolean {
    return BACKUP_ID.test(backupId) && backupId.startsWith(`logical-full_${projectRef}_`);
}

function verifiedBackup(value: unknown, projectRef: string): VerifiedLogicalBackup | null {
    if (!isRecord(value)
        || typeof value.backup_id !== "string"
        || !backupBelongsToProject(value.backup_id, projectRef)
        || value.project_ref !== projectRef
        || typeof value.database !== "string"
        || !SAFE_DATABASE.test(value.database)
        || value.kind !== "logical-full"
        || !canonicalTimestamp(value.created_at)
        || !canonicalTimestamp(value.completed_at)
        || new Date(value.completed_at).valueOf() < new Date(value.created_at).valueOf()
        || typeof value.bytes !== "number"
        || !Number.isSafeInteger(value.bytes)
        || value.bytes <= 0
        || typeof value.sha256 !== "string"
        || !SHA256.test(value.sha256)) return null;
    return {
        backup_id: value.backup_id,
        project_ref: projectRef,
        database: value.database,
        kind: "logical-full",
        created_at: value.created_at,
        completed_at: value.completed_at,
        bytes: value.bytes,
        sha256: value.sha256,
    };
}

function backupInventory(value: unknown, projectRef: string): VerifiedLogicalBackup[] | null {
    if (!isRecord(value) || !Array.isArray(value.backups)) return null;
    const backups = value.backups.map((backup) => verifiedBackup(backup, projectRef));
    if (backups.some((backup) => backup === null)) return null;
    const inventory = backups as VerifiedLogicalBackup[];
    return new Set(inventory.map((backup) => backup.backup_id)).size === inventory.length
        ? inventory
        : null;
}

function publicBackup(backup: VerifiedLogicalBackup) {
    return {
        backup_id: backup.backup_id,
        project_ref: backup.project_ref,
        kind: backup.kind,
        created_at: backup.created_at,
        completed_at: backup.completed_at,
        bytes: backup.bytes,
        sha256: backup.sha256,
    };
}

function equalBackup(left: VerifiedLogicalBackup, right: VerifiedLogicalBackup): boolean {
    return left.backup_id === right.backup_id
        && left.project_ref === right.project_ref
        && left.database === right.database
        && left.kind === right.kind
        && left.created_at === right.created_at
        && left.completed_at === right.completed_at
        && left.bytes === right.bytes
        && left.sha256 === right.sha256;
}

function newlyCreatedBackup(
    before: readonly VerifiedLogicalBackup[],
    after: readonly VerifiedLogicalBackup[],
): VerifiedLogicalBackup | null {
    const afterById = new Map(after.map((backup) => [backup.backup_id, backup]));
    for (const previous of before) {
        const current = afterById.get(previous.backup_id);
        if (!current || !equalBackup(previous, current)) return null;
    }
    const known = new Set(before.map((backup) => backup.backup_id));
    const additions = after.filter((backup) => !known.has(backup.backup_id));
    return additions.length === 1 ? additions[0]! : null;
}

function endpoint(projectRef: string): string {
    if (!validProjectRef(projectRef)) throw new Error("'ref' is invalid for release controls");
    return `/v1/projects/${encodeURIComponent(projectRef)}`;
}

function httpFailure(operation: ReleaseOperation, response: HttpResult<unknown>): ReleaseControlToolResponse {
    if (response.responseReadError) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", response.status);
    }
    return releaseControlFailure(operation, "HTTP_ERROR", response.transportError ? null : response.status);
}

function mutationFailure(operation: ReleaseOperation, response: HttpResult<unknown>): ReleaseControlToolResponse {
    if (response.responseReadError || response.transportError || response.status === 408 || response.status >= 500) {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.transportError ? null : response.status);
    }
    return releaseControlFailure(operation, "HTTP_ERROR", response.status);
}

async function readInventory(
    http: HttpTransport,
    projectRef: string,
): Promise<{ response: HttpResult<unknown>; inventory: VerifiedLogicalBackup[] | null }> {
    const response = await http.get(`${endpoint(projectRef)}/database/backups/logical`, {
        maxJsonBytes: INVENTORY_MAX_BYTES,
        responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS,
    });
    return { response, inventory: response.ok && response.status === 200 ? backupInventory(response.data, projectRef) : null };
}

function readInventoryFailure(
    operation: ReleaseOperation,
    read: { response: HttpResult<unknown>; inventory: VerifiedLogicalBackup[] | null },
): ReleaseControlToolResponse | null {
    if (!read.response.ok) return httpFailure(operation, read.response);
    if (read.response.status !== 200 || !read.inventory) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", read.response.status);
    }
    return null;
}

function postgrestStatus(value: unknown): ReleasePostgrestStatus | null {
    if (!isRecord(value)
        || value.component !== "postgrest"
        || !["running", "stopped"].includes(String(value.desired))
        || !["running", "stopped", "starting", "error"].includes(String(value.actual))
        || !["healthy", "unhealthy", "unknown"].includes(String(value.health))) return null;
    return {
        desired: value.desired as ReleasePostgrestStatus["desired"],
        actual: value.actual as ReleasePostgrestStatus["actual"],
        health: value.health as ReleasePostgrestStatus["health"],
    };
}

async function readPostgrestStatus(
    http: HttpTransport,
    projectRef: string,
): Promise<{ response: HttpResult<unknown>; status: ReleasePostgrestStatus | null }> {
    const response = await http.get(`${endpoint(projectRef)}/services/postgrest/status`, {
        maxJsonBytes: MUTATION_MAX_BYTES,
        responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS,
    });
    return { response, status: response.ok && response.status === 200 ? postgrestStatus(response.data) : null };
}

function readPostgrestFailure(
    operation: ReleaseOperation,
    read: { response: HttpResult<unknown>; status: ReleasePostgrestStatus | null },
): ReleaseControlToolResponse | null {
    if (!read.response.ok) return httpFailure(operation, read.response);
    return read.response.status === 200 && read.status
        ? null
        : releaseControlFailure(operation, "INVALID_RESPONSE", read.response.status);
}

function isRestartReceipt(value: unknown): boolean {
    return isRecord(value)
        && value.service === "postgrest"
        && value.action === "restart"
        && value.success === true;
}

export function registerReleaseTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectRef?: string } = {},
): void {
    server.tool(
        "release",
        "Verified release controls using a Management API credential. Actions: logical_backup_list, logical_backup_create, postgrest_status, postgrest_restart",
        {
            action: withDescription(stringEnum([
                "logical_backup_list", "logical_backup_create", "postgrest_status", "postgrest_restart",
            ]), "Release control action"),
            ref: optional(Type.String(), options.projectRef ? "Optional override when not auto-linked" : "Project ref"),
        },
        async ({ action, ref }) => {
            const projectRef = typeof ref === "string" && ref || options.projectRef;
            if (!projectRef) throw new Error("'ref' is required for release controls");
            if (!validProjectRef(projectRef)) throw new Error("'ref' is invalid for release controls");

            if (action === "logical_backup_list") {
                const read = await readInventory(http, projectRef);
                const failure = readInventoryFailure("release.logical_backup.list", read);
                return failure ?? releaseControlSuccess("release.logical_backup.list", {
                    project_ref: projectRef,
                    backups: read.inventory!.map(publicBackup),
                });
            }
            if (action === "logical_backup_create") {
                const before = await readInventory(http, projectRef);
                const beforeFailure = readInventoryFailure("release.logical_backup.create", before);
                if (beforeFailure) return beforeFailure;
                const mutation = await http.postReleaseMutation(`${endpoint(projectRef)}/database/backups/logical`, {}, {
                    timeoutMs: BACKUP_TIMEOUT_MS,
                });
                const after = await readInventory(http, projectRef);
                if (!mutation.ok || mutation.status !== 200) {
                    return mutationFailure("release.logical_backup.create", mutation);
                }
                const responseBackup = isRecord(mutation.data) ? verifiedBackup(mutation.data.backup, projectRef) : null;
                const afterFailure = readInventoryFailure("release.logical_backup.create", after);
                const addedBackup = after.inventory && newlyCreatedBackup(before.inventory!, after.inventory);
                if (!responseBackup || afterFailure || !addedBackup || !equalBackup(responseBackup, addedBackup)) {
                    return releaseControlFailure("release.logical_backup.create", "OUTCOME_UNKNOWN", mutation.status);
                }
                return releaseControlSuccess("release.logical_backup.create", {
                    project_ref: projectRef,
                    backup: publicBackup(addedBackup),
                });
            }
            if (action === "postgrest_status") {
                const read = await readPostgrestStatus(http, projectRef);
                const failure = readPostgrestFailure("release.postgrest.status", read);
                return failure ?? releaseControlSuccess("release.postgrest.status", {
                    project_ref: projectRef,
                    postgrest: read.status!,
                });
            }
            if (action !== "postgrest_restart") throw new Error("Unknown release control action");
            const mutation = await http.postReleaseMutation(`${endpoint(projectRef)}/services/postgrest/restart`);
            const read = await readPostgrestStatus(http, projectRef);
            if (!mutation.ok || mutation.status !== 200) {
                return mutationFailure("release.postgrest.restart", mutation);
            }
            const readFailure = readPostgrestFailure("release.postgrest.restart", read);
            if (!isRestartReceipt(mutation.data) || readFailure
                || read.status!.desired !== "running"
                || read.status!.actual !== "running"
                || read.status!.health !== "healthy") {
                return releaseControlFailure("release.postgrest.restart", "OUTCOME_UNKNOWN", mutation.status);
            }
            return releaseControlSuccess("release.postgrest.restart", {
                project_ref: projectRef,
                postgrest: read.status,
            });
        },
    );
}
