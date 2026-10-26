export type ControlPlaneSafetyEvidence = {
    backup_id: string;
    backup_directory: string;
    bytes: number;
    candidate_counts: Record<string, number>;
    completed_at: string;
    current_key_checkpoint_present: boolean;
    schema: "supacloud.control-plane-upgrade-safety.v1";
    sha256: string;
};

const CONTROL_PLANE_BACKUP_ROOT = "/var/lib/supacloud/backups/control-plane-upgrades";
const RECEIPT_FIELDS = [
    "backup_id", "backup_directory", "bytes", "candidate_counts", "completed_at",
    "current_key_checkpoint_present", "schema", "sha256",
];
const CANDIDATE_FIELDS = [
    "deprecated_webhook_secrets", "legacy_deployment_history_rows", "legacy_project_config_rows",
    "opaque_key_backfill_projects", "stored_secret_values",
];

function exactObjectKeys(candidate: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(candidate).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === expected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function nonNegativeIntegerRecord(candidate: unknown): candidate is Record<string, number> {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    return exactObjectKeys(candidate as Record<string, unknown>, CANDIDATE_FIELDS)
        && Object.values(candidate).every(count => Number.isSafeInteger(count) && Number(count) >= 0);
}

function canonicalTimestamp(candidate: unknown): candidate is string {
    if (typeof candidate !== "string") return false;
    const timestamp = new Date(candidate);
    return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === candidate;
}

function validSafetyReceipt(receipt: Record<string, unknown>): boolean {
    const validBackupId = typeof receipt.backup_id === "string"
        && /^control-plane-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.backup_id);
    return exactObjectKeys(receipt, RECEIPT_FIELDS)
        && receipt.schema === "supacloud.control-plane-upgrade-safety.v1"
        && validBackupId
        && receipt.backup_directory === `${CONTROL_PLANE_BACKUP_ROOT}/${receipt.backup_id}`
        && Number.isSafeInteger(receipt.bytes) && Number(receipt.bytes) > 0
        && canonicalTimestamp(receipt.completed_at)
        && typeof receipt.current_key_checkpoint_present === "boolean"
        && typeof receipt.sha256 === "string" && /^[0-9a-f]{64}$/.test(receipt.sha256)
        && nonNegativeIntegerRecord(receipt.candidate_counts);
}

function hasUniqueReceiptFields(json: string): boolean {
    // JSON.parse discards earlier duplicate values; the closed receipt schema
    // has globally distinct field names, so every source field must occur once.
    const names = [...json.matchAll(/"(?:\\.|[^"\\])*"/g)]
        .filter(token => /^\s*:/.test(json.slice(token.index + token[0].length)))
        .map(token => JSON.parse(token[0]) as string);
    return names.length === RECEIPT_FIELDS.length + CANDIDATE_FIELDS.length
        && new Set(names).size === names.length;
}

export function parseControlPlaneSafetyReceipt(log: string, prefix: string): ControlPlaneSafetyEvidence {
    const receiptLines = log.split(/\r?\n/).filter(line => line.startsWith(prefix));
    if (receiptLines.length !== 1) throw new Error("Remote upgrade did not emit one control-plane safety receipt");
    const json = receiptLines[0]!.slice(prefix.length);
    let candidate: unknown;
    try {
        candidate = JSON.parse(json);
    } catch {
        throw new Error("Remote control-plane safety receipt is not valid JSON");
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
        || !validSafetyReceipt(candidate as Record<string, unknown>) || !hasUniqueReceiptFields(json)) {
        throw new Error("Remote control-plane safety receipt is invalid");
    }
    return candidate as ControlPlaneSafetyEvidence;
}
