import type { HttpResult, HttpTransport } from "../transports/http";

type AdminLogicalBackupToolResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type LogicalBackupOperation =
    | "platform.list_logical_backups"
    | "platform.create_logical_backup"
    | "platform.restore_logical_backup";

type LogicalBackupIdentity = {
    backup_id: string;
    project_ref: string;
    database: string;
    kind: "logical-full";
    created_at: string;
    completed_at: string;
    bytes: number;
    sha256: string;
};

type LogicalBackupInventoryRead = {
    inventory?: LogicalBackupIdentity[];
    response: HttpResult<unknown>;
};

interface RestoreLogicalBackupRequest {
    projectRef: string;
    backupId: string;
    expectedSha256: string;
    confirmation: string;
}

const RELEASE_CONTROL_RESPONSE_SCHEMA = "supacloud.cli.release-control.v1";
const SAFE_PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID = /^logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/;
const BACKUP_ID_SUFFIX = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DATABASE = /^[^\u0000-\u001f\u007f]{1,128}$/;
const LOGICAL_BACKUP_REQUEST_TIMEOUT_MS = 36 * 60_000;
const LOGICAL_BACKUP_INVENTORY_MAX_BYTES = 1024 * 1024;
const LOGICAL_BACKUP_MUTATION_MAX_BYTES = 64 * 1024;

function logicalBackupResponse(payload: Record<string, unknown>): AdminLogicalBackupToolResponse {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function logicalBackupSuccess(
    operation: LogicalBackupOperation,
    payload: Record<string, unknown>,
): AdminLogicalBackupToolResponse {
    return logicalBackupResponse({
        ...payload,
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: true,
        operation,
    });
}

function logicalBackupFailure(
    operation: LogicalBackupOperation,
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "OUTCOME_UNKNOWN",
    httpStatus: number | null,
): AdminLogicalBackupToolResponse {
    return {
        ...logicalBackupResponse({
            schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
            ok: false,
            operation,
            error: { code, http_status: httpStatus },
        }),
        isError: true,
    };
}

function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(candidate: unknown): candidate is string {
    if (typeof candidate !== "string") return false;
    const timestamp = new Date(candidate);
    return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === candidate;
}

function backupBelongsToProject(backupId: string, projectRef: string): boolean {
    const prefix = `logical-full_${projectRef}_`;
    return BACKUP_ID.test(backupId)
        && backupId.startsWith(prefix)
        && BACKUP_ID_SUFFIX.test(backupId.slice(prefix.length));
}

function validBackupProject(
    candidate: Record<string, unknown>,
    projectRef: string,
): candidate is Record<string, unknown> & { backup_id: string; project_ref: string } {
    return typeof candidate.backup_id === "string"
        && backupBelongsToProject(candidate.backup_id, projectRef)
        && candidate.project_ref === projectRef;
}

function validBackupDatabase(
    candidate: Record<string, unknown>,
): candidate is Record<string, unknown> & { database: string } {
    return typeof candidate.database === "string" && SAFE_DATABASE.test(candidate.database);
}

function validBackupTimestamps(
    candidate: Record<string, unknown>,
): candidate is Record<string, unknown> & { created_at: string; completed_at: string } {
    return canonicalTimestamp(candidate.created_at)
        && canonicalTimestamp(candidate.completed_at)
        && new Date(candidate.completed_at).valueOf() >= new Date(candidate.created_at).valueOf();
}

function validBackupEvidence(
    candidate: Record<string, unknown>,
): candidate is Record<string, unknown> & { bytes: number; sha256: string } {
    return Number.isSafeInteger(candidate.bytes)
        && Number(candidate.bytes) > 0
        && typeof candidate.sha256 === "string"
        && SHA256.test(candidate.sha256);
}

function logicalBackupIdentity(
    candidate: unknown,
    projectRef: string,
): LogicalBackupIdentity | null {
    if (!isPlainRecord(candidate)) return null;
    if (!validBackupProject(candidate, projectRef)
        || !validBackupDatabase(candidate)
        || candidate.kind !== "logical-full"
        || !validBackupTimestamps(candidate)
        || !validBackupEvidence(candidate)) {
        return null;
    }
    return {
        backup_id: candidate.backup_id,
        project_ref: projectRef,
        database: candidate.database,
        kind: "logical-full",
        created_at: candidate.created_at,
        completed_at: candidate.completed_at,
        bytes: Number(candidate.bytes),
        sha256: candidate.sha256,
    };
}

function logicalBackupInventory(payload: unknown, projectRef: string): LogicalBackupIdentity[] | null {
    if (!isPlainRecord(payload) || !Array.isArray(payload.backups)) return null;
    const backups = payload.backups.map((candidate) => logicalBackupIdentity(candidate, projectRef));
    if (backups.some((backup) => backup === null)) return null;
    const inventory = backups as LogicalBackupIdentity[];
    if (new Set(inventory.map((backup) => backup.backup_id)).size !== inventory.length) return null;
    return inventory;
}

function assertProjectRef(projectRef: string): void {
    if (!SAFE_PROJECT_REF.test(projectRef)) {
        throw new Error("'ref' is invalid for verified logical backup");
    }
}

function logicalBackupEndpoint(projectRef: string): string {
    assertProjectRef(projectRef);
    return `/v1/projects/${encodeURIComponent(projectRef)}/database/backups/logical`;
}

async function readLogicalBackupInventory(
    http: HttpTransport,
    projectRef: string,
): Promise<LogicalBackupInventoryRead> {
    const response = await http.get(logicalBackupEndpoint(projectRef), {
        maxJsonBytes: LOGICAL_BACKUP_INVENTORY_MAX_BYTES,
    });
    return {
        response,
        inventory: response.ok
            ? logicalBackupInventory(response.data, projectRef) ?? undefined
            : undefined,
    };
}

function mutationFailureCode(response: HttpResult<unknown>): "HTTP_ERROR" | "OUTCOME_UNKNOWN" {
    return response.transportError
        || response.responseError
        || response.status === 408
        || response.status >= 500
        ? "OUTCOME_UNKNOWN"
        : "HTTP_ERROR";
}

function identicalBackup(
    left: LogicalBackupIdentity,
    right: LogicalBackupIdentity,
): boolean {
    return left.backup_id === right.backup_id
        && left.project_ref === right.project_ref
        && left.database === right.database
        && left.kind === right.kind
        && left.created_at === right.created_at
        && left.completed_at === right.completed_at
        && left.bytes === right.bytes
        && left.sha256 === right.sha256;
}

function createdBackup(
    previous: readonly LogicalBackupIdentity[],
    current: readonly LogicalBackupIdentity[],
): LogicalBackupIdentity | null {
    const currentById = new Map(current.map((backup) => [backup.backup_id, backup]));
    const previousIds = new Set<string>();
    for (const previousBackup of previous) {
        previousIds.add(previousBackup.backup_id);
        const currentBackup = currentById.get(previousBackup.backup_id);
        if (!currentBackup || !identicalBackup(previousBackup, currentBackup)) return null;
    }
    const additions = current.filter((backup) => !previousIds.has(backup.backup_id));
    return additions.length === 1 ? additions[0]! : null;
}

function exactBackupEnvelope(
    payload: unknown,
    field: "backup" | "restored_backup",
    projectRef: string,
): LogicalBackupIdentity | null {
    return isPlainRecord(payload) ? logicalBackupIdentity(payload[field], projectRef) : null;
}

function inventoryReadFailure(
    operation: LogicalBackupOperation,
    read: LogicalBackupInventoryRead,
): AdminLogicalBackupToolResponse | null {
    const { response, inventory } = read;
    if (!response.ok || response.status !== 200) {
        const code = response.ok || response.responseError ? "INVALID_RESPONSE" : "HTTP_ERROR";
        const status = response.transportError ? null : response.status;
        return logicalBackupFailure(operation, code, status);
    }
    return inventory ? null : logicalBackupFailure(operation, "INVALID_RESPONSE", response.status);
}

function createReceipt(
    projectRef: string,
    previous: readonly LogicalBackupIdentity[],
    mutation: HttpResult<unknown>,
    afterRead: LogicalBackupInventoryRead,
): AdminLogicalBackupToolResponse {
    const operation = "platform.create_logical_backup";
    if (!mutation.ok) {
        const status = mutation.transportError ? null : mutation.status;
        return logicalBackupFailure(operation, mutationFailureCode(mutation), status);
    }
    if (mutation.status !== 200) return logicalBackupFailure(operation, "OUTCOME_UNKNOWN", mutation.status);
    const responseBackup = exactBackupEnvelope(mutation.data, "backup", projectRef);
    const addedBackup = afterRead.response.ok && afterRead.response.status === 200 && afterRead.inventory
        ? createdBackup(previous, afterRead.inventory)
        : null;
    if (!responseBackup || !addedBackup || !identicalBackup(responseBackup, addedBackup)) {
        return logicalBackupFailure(operation, "OUTCOME_UNKNOWN", mutation.status);
    }
    return logicalBackupSuccess(operation, { project_ref: projectRef, backup: addedBackup });
}

export async function listVerifiedLogicalBackups(
    http: HttpTransport,
    projectRef: string,
): Promise<AdminLogicalBackupToolResponse> {
    const operation = "platform.list_logical_backups";
    const read = await readLogicalBackupInventory(http, projectRef);
    const failure = inventoryReadFailure(operation, read);
    return failure ?? logicalBackupSuccess(operation, {
        project_ref: projectRef,
        backups: read.inventory!,
    });
}

export async function createVerifiedLogicalBackup(
    http: HttpTransport,
    projectRef: string,
): Promise<AdminLogicalBackupToolResponse> {
    const operation = "platform.create_logical_backup";
    const beforeRead = await readLogicalBackupInventory(http, projectRef);
    const failure = inventoryReadFailure(operation, beforeRead);
    if (failure) return failure;
    const mutation = await http.post(
        logicalBackupEndpoint(projectRef),
        {},
        {
            timeoutMs: LOGICAL_BACKUP_REQUEST_TIMEOUT_MS,
            maxJsonBytes: LOGICAL_BACKUP_MUTATION_MAX_BYTES,
        },
    );
    const afterRead = await readLogicalBackupInventory(http, projectRef);
    return createReceipt(projectRef, beforeRead.inventory!, mutation, afterRead);
}

function expectedRestoreConfirmation(request: RestoreLogicalBackupRequest): string {
    return [
        "RESTORE_PROJECT",
        request.projectRef,
        request.backupId,
        request.expectedSha256,
    ].join(":");
}

function assertRestoreRequest(request: RestoreLogicalBackupRequest): void {
    assertProjectRef(request.projectRef);
    if (!backupBelongsToProject(request.backupId, request.projectRef)) {
        throw new Error("'backup_id' must belong to the requested project");
    }
    if (!SHA256.test(request.expectedSha256)) {
        throw new Error("'expected_sha256' must be exactly 64 lowercase hexadecimal characters");
    }
    if (request.confirmation !== expectedRestoreConfirmation(request)) {
        throw new Error("'confirmation' must exactly bind the project ref, backup ID, and SHA-256");
    }
}

function restoreReceipt(
    request: RestoreLogicalBackupRequest,
    requestedBackup: LogicalBackupIdentity,
    mutation: HttpResult<unknown>,
): AdminLogicalBackupToolResponse {
    const operation = "platform.restore_logical_backup";
    if (!mutation.ok) {
        const status = mutation.transportError ? null : mutation.status;
        return logicalBackupFailure(operation, mutationFailureCode(mutation), status);
    }
    if (mutation.status !== 200) return logicalBackupFailure(operation, "OUTCOME_UNKNOWN", mutation.status);
    const restoredBackup = exactBackupEnvelope(mutation.data, "restored_backup", request.projectRef);
    if (!restoredBackup || !identicalBackup(restoredBackup, requestedBackup)) {
        return logicalBackupFailure(operation, "OUTCOME_UNKNOWN", mutation.status);
    }
    return logicalBackupSuccess(operation, {
        project_ref: request.projectRef,
        restored_backup: restoredBackup,
    });
}

export async function restoreVerifiedLogicalBackup(
    http: HttpTransport,
    request: RestoreLogicalBackupRequest,
): Promise<AdminLogicalBackupToolResponse> {
    const operation = "platform.restore_logical_backup";
    assertRestoreRequest(request);
    const beforeRead = await readLogicalBackupInventory(http, request.projectRef);
    const failure = inventoryReadFailure(operation, beforeRead);
    if (failure) return failure;
    const requestedBackup = beforeRead.inventory!.find((backup) => backup.backup_id === request.backupId);
    if (!requestedBackup || requestedBackup.sha256 !== request.expectedSha256) {
        return logicalBackupFailure(operation, "INVALID_RESPONSE", beforeRead.response.status);
    }
    const mutation = await http.post(
        `${logicalBackupEndpoint(request.projectRef)}/restore`,
        {
            backup_id: request.backupId,
            expected_sha256: request.expectedSha256,
            confirmation: request.confirmation,
        },
        {
            timeoutMs: LOGICAL_BACKUP_REQUEST_TIMEOUT_MS,
            maxJsonBytes: LOGICAL_BACKUP_MUTATION_MAX_BYTES,
        },
    );
    return restoreReceipt(request, requestedBackup, mutation);
}
