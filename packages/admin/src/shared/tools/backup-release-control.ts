import type { HttpResult, HttpTransport } from "../transports/http";

export type AdminBackupToolResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type BackupRecord = {
    id: string;
    type: "full" | "incr" | "diff";
    timestamp: { start: number; stop: number };
    size: number;
    database: string;
};

type BackupInventoryRead = {
    inventory?: BackupRecord[];
    response: HttpResult<unknown>;
};

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_BACKUP_FIELD = /^[A-Za-z0-9_.-]{1,128}$/;

function nonnegativeSafeInteger(candidate: unknown): candidate is number {
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
}

function backupTimestamp(candidate: unknown): BackupRecord["timestamp"] | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const timestamp = candidate as Record<string, unknown>;
    if (!nonnegativeSafeInteger(timestamp.start) || !nonnegativeSafeInteger(timestamp.stop)) return null;
    if (timestamp.stop > 0 && timestamp.stop < timestamp.start) return null;
    return { start: timestamp.start, stop: timestamp.stop };
}

function backupFailure(
    operation: string,
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "OUTCOME_UNKNOWN",
    httpStatus: number | null,
): AdminBackupToolResponse {
    return {
        isError: true,
        content: [{
            type: "text",
            text: JSON.stringify({
                ok: false,
                operation,
                error: { code, http_status: httpStatus },
            }),
        }],
    };
}

function backupRecord(candidate: unknown): BackupRecord | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    const timestamp = backupTimestamp(record.timestamp);
    if (!timestamp) return null;
    if (typeof record.id !== "string" || !SAFE_BACKUP_FIELD.test(record.id)) return null;
    if (record.type !== "full" && record.type !== "incr" && record.type !== "diff") return null;
    if (!nonnegativeSafeInteger(record.size)) return null;
    if (typeof record.database !== "string" || !SAFE_BACKUP_FIELD.test(record.database)) return null;
    return {
        id: record.id,
        type: record.type,
        timestamp,
        size: record.size,
        database: record.database,
    };
}

function backupInventory(payload: unknown): BackupRecord[] | null {
    if (!Array.isArray(payload)) return null;
    const records = payload.map(backupRecord);
    if (records.some((record) => record === null)) return null;
    const inventory = records as BackupRecord[];
    return new Set(inventory.map((record) => record.id)).size === inventory.length
        ? inventory
        : null;
}

function backupEndpoint(projectRef: string): string {
    if (!SAFE_PATH_SEGMENT.test(projectRef)) throw new Error("'ref' is invalid for physical backup");
    return `/v1/projects/${encodeURIComponent(projectRef)}/database/backups`;
}

async function readBackupInventory(
    http: HttpTransport,
    endpoint: string,
): Promise<BackupInventoryRead> {
    const response = await http.get(endpoint);
    return { response, inventory: response.ok ? backupInventory(response.data) ?? undefined : undefined };
}

function successfulBackupResponse(payload: object): AdminBackupToolResponse {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function completedFullBackup(
    before: readonly BackupRecord[],
    after: readonly BackupRecord[],
): BackupRecord | null {
    const previousIds = new Set(before.map((backup) => backup.id));
    const candidates = after.filter((backup) => (
        !previousIds.has(backup.id)
        && backup.type === "full"
        && backup.timestamp.stop > 0
        && backup.size > 0
    ));
    return candidates.length === 1 ? candidates[0] : null;
}

function mutationFailureCode(statusCode: number): "HTTP_ERROR" | "OUTCOME_UNKNOWN" {
    return statusCode >= 400 && statusCode < 500 && statusCode !== 408
        ? "HTTP_ERROR"
        : "OUTCOME_UNKNOWN";
}

function confirmsFullBackup(payload: unknown): boolean {
    return Boolean(payload)
        && typeof payload === "object"
        && !Array.isArray(payload)
        && (payload as Record<string, unknown>).message === "full backup completed";
}

function reconciledCreationResponse(
    projectRef: string,
    before: readonly BackupRecord[],
    creation: HttpResult<unknown>,
    afterRead: BackupInventoryRead,
): AdminBackupToolResponse {
    if (!creation.ok) {
        return backupFailure("platform.create_backup", mutationFailureCode(creation.status), creation.status);
    }
    if (!confirmsFullBackup(creation.data)) {
        return backupFailure("platform.create_backup", "OUTCOME_UNKNOWN", creation.status);
    }
    if (!afterRead.response.ok || !afterRead.inventory) {
        return backupFailure("platform.create_backup", "OUTCOME_UNKNOWN", afterRead.response.status);
    }
    const backup = completedFullBackup(before, afterRead.inventory);
    if (!backup) return backupFailure("platform.create_backup", "OUTCOME_UNKNOWN", afterRead.response.status);
    return successfulBackupResponse({ project_ref: projectRef, requested_type: "full", backup });
}

export async function listPhysicalBackups(
    http: HttpTransport,
    projectRef: string,
): Promise<AdminBackupToolResponse> {
    const { response, inventory } = await readBackupInventory(http, backupEndpoint(projectRef));
    if (!response.ok) return backupFailure("platform.list_backups", "HTTP_ERROR", response.status);
    if (!inventory) return backupFailure("platform.list_backups", "INVALID_RESPONSE", null);
    return successfulBackupResponse(inventory);
}

export async function createFullPhysicalBackup(
    http: HttpTransport,
    projectRef: string,
): Promise<AdminBackupToolResponse> {
    const endpoint = backupEndpoint(projectRef);
    const beforeRead = await readBackupInventory(http, endpoint);
    if (!beforeRead.response.ok) {
        return backupFailure("platform.create_backup", "HTTP_ERROR", beforeRead.response.status);
    }
    if (!beforeRead.inventory) return backupFailure("platform.create_backup", "INVALID_RESPONSE", null);

    const creation = await http.post(endpoint, { type: "full" });
    const afterRead = await readBackupInventory(http, endpoint);
    return reconciledCreationResponse(projectRef, beforeRead.inventory, creation, afterRead);
}
