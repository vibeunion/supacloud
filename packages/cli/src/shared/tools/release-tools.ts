import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import { releaseControlFailure, releaseControlSuccess, type ReleaseControlToolResponse } from "./release-control-response";
import { PROJECT_ENDPOINT_RESPONSE_MAX_BYTES, projectApiOrigins } from "./project-endpoint-read";

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
    | "release.logical_backup.restore"
    | "release.postgrest.status"
    | "release.postgrest.restart"
    | "release.release_canary.fixture_stage_replay";

type ReleaseCanaryStageReceipt = {
    fixtureId: string;
    tenantKey: string;
    state: "staged";
    idempotent: true;
};

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_CANARY_TENANT_KEY = /^release-canary-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_CANARY_STAGE_RECEIPT_KEYS = new Set(["fixtureId", "tenantKey", "state", "idempotent"]);

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

function restoreRequest(
    projectRef: string,
    backupId: unknown,
    expectedSha256: unknown,
    restoreConfirmation: unknown,
): { backup_id: string; expected_sha256: string; confirmation: string } {
    if (typeof backupId !== "string" || !backupBelongsToProject(backupId, projectRef)) {
        throw new Error("'backup_id' must identify a logical-full backup for 'ref'");
    }
    if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
        throw new Error("'expected_sha256' must be a lowercase SHA-256 digest");
    }
    const confirmation = `RESTORE_PROJECT:${projectRef}:${backupId}:${expectedSha256}`;
    if (restoreConfirmation !== confirmation) {
        throw new Error("'restore_confirmation' must exactly confirm the selected logical backup restore");
    }
    return { backup_id: backupId, expected_sha256: expectedSha256, confirmation };
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

function releaseCanaryStageInput(subject: unknown, requestId: unknown): { p_subject: string; p_request_id: string } {
    if (typeof subject !== "string" || !UUID.test(subject)) throw new Error("'subject' must be a canonical UUID");
    if (typeof requestId !== "string" || !UUID.test(requestId)) throw new Error("'request_id' must be a canonical UUID");
    return { p_subject: subject, p_request_id: requestId };
}

function releaseCanaryStageReceipt(value: unknown): ReleaseCanaryStageReceipt | null {
    if (!isRecord(value)
        || Object.keys(value).some((key) => !RELEASE_CANARY_STAGE_RECEIPT_KEYS.has(key))
        || Object.keys(value).length !== RELEASE_CANARY_STAGE_RECEIPT_KEYS.size
        || typeof value.fixtureId !== "string"
        || !UUID.test(value.fixtureId)
        || typeof value.tenantKey !== "string"
        || !RELEASE_CANARY_TENANT_KEY.test(value.tenantKey)
        || value.state !== "staged"
        || value.idempotent !== true) return null;
    return {
        fixtureId: value.fixtureId,
        tenantKey: value.tenantKey,
        state: "staged",
        idempotent: true,
    };
}

async function applicationOriginMatches(http: HttpTransport, projectRef: string, applicationOrigin: string): Promise<boolean> {
    const endpointRead = await http.get(
        `${endpoint(projectRef)}/endpoint/projection`,
        { maxResponseBytes: PROJECT_ENDPOINT_RESPONSE_MAX_BYTES },
    );
    return projectApiOrigins(endpointRead, projectRef)?.includes(applicationOrigin) === true;
}

export function registerReleaseTools(
    server: ToolServer,
    http: HttpTransport,
    options: { projectRef?: string; applicationHttp?: HttpTransport; applicationOrigin?: string } = {},
): void {
    server.tool(
        "release",
        "Verified release controls. Management actions use the Management API; release_canary_fixture_stage_replay additionally requires the selected project's SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        {
            action: withDescription(stringEnum([
                "logical_backup_list", "logical_backup_create", "logical_backup_restore", "postgrest_status", "postgrest_restart", "release_canary_fixture_stage_replay",
            ]), "Release control action"),
            ref: optional(Type.String(), options.projectRef ? "Optional override when not auto-linked" : "Project ref"),
            backup_id: optional(Type.String(), "[logical_backup_restore] Exact verified logical-full backup ID from the selected project inventory"),
            expected_sha256: optional(Type.String(), "[logical_backup_restore] Exact lowercase SHA-256 from the selected project inventory"),
            restore_confirmation: optional(Type.String(), "[logical_backup_restore] Exact RESTORE_PROJECT:<ref>:<backup_id>:<sha256> confirmation"),
            subject: optional(Type.String(), "[release_canary_fixture_stage_replay] Exact central subject UUID"),
            request_id: optional(Type.String(), "[release_canary_fixture_stage_replay] Exact idempotent stage request UUID"),
        },
        async ({ action, ref, backup_id, expected_sha256, restore_confirmation, subject, request_id }) => {
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
            if (action === "logical_backup_restore") {
                const request = restoreRequest(projectRef, backup_id, expected_sha256, restore_confirmation);
                const before = await readInventory(http, projectRef);
                const beforeFailure = readInventoryFailure("release.logical_backup.restore", before);
                if (beforeFailure) return beforeFailure;
                const selectedBackup = before.inventory!.find((backup) =>
                    backup.backup_id === request.backup_id && backup.sha256 === request.expected_sha256,
                );
                if (!selectedBackup) {
                    return releaseControlFailure("release.logical_backup.restore", "MUTATION_NOT_SUCCEEDED", null);
                }
                const mutation = await http.postReleaseMutation(
                    `${endpoint(projectRef)}/database/backups/logical/restore`,
                    request,
                    { timeoutMs: BACKUP_TIMEOUT_MS },
                );
                if (!mutation.ok || mutation.status !== 200) {
                    return mutationFailure("release.logical_backup.restore", mutation);
                }
                const responseBackup = isRecord(mutation.data)
                    ? verifiedBackup(mutation.data.restored_backup, projectRef)
                    : null;
                const after = await readInventory(http, projectRef);
                const afterFailure = readInventoryFailure("release.logical_backup.restore", after);
                const restoredInventoryBackup = after.inventory?.find((backup) => backup.backup_id === request.backup_id);
                if (!responseBackup
                    || !equalBackup(responseBackup, selectedBackup)
                    || afterFailure
                    || !restoredInventoryBackup
                    || !equalBackup(restoredInventoryBackup, selectedBackup)) {
                    return releaseControlFailure("release.logical_backup.restore", "OUTCOME_UNKNOWN", mutation.status);
                }
                return releaseControlSuccess("release.logical_backup.restore", {
                    project_ref: projectRef,
                    backup: publicBackup(selectedBackup),
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
            if (action === "release_canary_fixture_stage_replay") {
                if (!options.applicationHttp || !options.applicationOrigin) {
                    throw new Error("release_canary_fixture_stage_replay requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
                }
                const request = releaseCanaryStageInput(subject, request_id);
                if (!await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure("release.release_canary.fixture_stage_replay", "INVALID_RESPONSE", null);
                }
                const response = await options.applicationHttp.postReleaseMutation(
                    "/rest/v1/rpc/fa_release_canary_fixture_stage",
                    request,
                );
                if (!response.ok || response.status !== 200) {
                    return mutationFailure("release.release_canary.fixture_stage_replay", response);
                }
                const receipt = releaseCanaryStageReceipt(response.data);
                if (!receipt || !await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure("release.release_canary.fixture_stage_replay", "OUTCOME_UNKNOWN", response.status);
                }
                return releaseControlSuccess("release.release_canary.fixture_stage_replay", {
                    project_ref: projectRef,
                    receipt,
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
