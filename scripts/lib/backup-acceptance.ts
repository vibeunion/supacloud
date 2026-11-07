export type BackupReadiness = {
  schema: "supacloud.backup-readiness.v1";
  provider: "pigsty.pgbackrest";
  stanza: string;
  status: "ready";
  repository_count: number;
  completed_backup_count: number;
  latest_completed_backup: {
    label?: string;
    timestamp?: { start?: number; stop?: number };
  } | null;
};

export type BackupAcceptance = {
  status: "confirmed" | "incomplete";
  reasons: string[];
  latest_success_at: string | null;
  freshness_seconds: number | null;
};

export function parseBackupReadiness(value: unknown): BackupReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid backup readiness document");
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== "supacloud.backup-readiness.v1" || row.provider !== "pigsty.pgbackrest"
    || row.status !== "ready" || typeof row.stanza !== "string" || !row.stanza) {
    throw new Error("Invalid backup readiness document");
  }
  if (!Number.isInteger(row.repository_count) || Number(row.repository_count) < 1
    || !Number.isInteger(row.completed_backup_count) || Number(row.completed_backup_count) < 0) {
    throw new Error("Invalid backup readiness document");
  }
  const latest = row.latest_completed_backup;
  if (latest !== null && (typeof latest !== "object" || Array.isArray(latest))) {
    throw new Error("Invalid backup readiness document");
  }
  return value as BackupReadiness;
}

export function evaluateBackupReadiness(
  value: BackupReadiness,
  nowMs = Date.now(),
  maxAgeSeconds = 24 * 60 * 60,
): BackupAcceptance {
  const reasons: string[] = [];
  const stop = value.latest_completed_backup?.timestamp?.stop;
  const latestSuccessAt = typeof stop === "number" && Number.isFinite(stop) && stop > 0
    ? new Date(stop * 1000).toISOString()
    : null;
  const freshnessSeconds = latestSuccessAt === null ? null : Math.max(0, Math.floor((nowMs - stop! * 1000) / 1000));

  if (value.repository_count < 1) reasons.push("backup_repository_missing");
  if (value.completed_backup_count < 1 || latestSuccessAt === null) reasons.push("completed_backup_missing");
  if (freshnessSeconds !== null && freshnessSeconds > maxAgeSeconds) reasons.push("backup_stale");
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) reasons.push("invalid_freshness_window");

  return {
    status: reasons.length === 0 ? "confirmed" : "incomplete",
    reasons,
    latest_success_at: latestSuccessAt,
    freshness_seconds: freshnessSeconds,
  };
}
