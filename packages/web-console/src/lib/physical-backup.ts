import type { BaseRecord } from "@svadmin/core";

export type PhysicalBackupRecord = BaseRecord & {
  id: string;
  type: "full" | "incr" | "diff";
  timestamp: {
    start: number;
    stop: number;
  };
  size: number;
  database?: string;
};

export interface PhysicalBackupViewModel {
  id: string;
  type: string;
  status: "completed" | "in_progress";
  timestamp: string;
  size: string;
  label: string;
}

export class BackupInventoryError extends Error {
  constructor(readonly status: number) {
    super(backupInventoryErrorMessage(status));
    this.name = "BackupInventoryError";
  }
}

export function backupInventoryErrorMessage(status: number): string {
  return status === 503
    ? "备份服务暂未就绪，请确认 pgBackRest 已配置并运行后重试。"
    : `无法加载备份历史（HTTP ${status}）`;
}

export function isBackupServiceUnavailable(error: unknown): boolean {
  return error instanceof BackupInventoryError && error.status === 503;
}

function formatTimestamp(epoch: number): string {
  const millis = epoch < 10_000_000_000 ? epoch * 1000 : epoch;
  return new Date(millis).toISOString();
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function toPhysicalBackupViewModel(backup: PhysicalBackupRecord): PhysicalBackupViewModel {
  const completed = backup.timestamp.stop > 0;
  return {
    id: backup.id,
    type: backup.type,
    status: completed ? "completed" : "in_progress",
    timestamp: formatTimestamp(completed ? backup.timestamp.stop : backup.timestamp.start),
    size: formatSize(backup.size),
    label: backup.id,
  };
}
