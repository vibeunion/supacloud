import { isRecord } from "./project-config";

export type LogSeverity = "debug" | "info" | "warning" | "error";
export const LOG_PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const sensitivePatterns = [
  /(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
  /(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
  /(jwt|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
  /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s,;]+/gi,
] as const;

export function redactLogMessage(message: string): string {
  const redacted = sensitivePatterns.reduce((value, pattern) => value.replace(pattern, "$1=[REDACTED]"), message);
  return redacted.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

const sensitiveField = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|client_secret|secret|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)$/i;

export function redactLogMetadata(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Log metadata exceeds its nesting limit");
  if (typeof value === "string") return redactLogMessage(value);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Array.from(value, (entry: unknown) => redactLogMetadata(entry, depth + 1));
  if (!isRecord(value)) throw new Error("Invalid log metadata");
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, sensitiveField.test(key) ? "[REDACTED]" : redactLogMetadata(entry, depth + 1),
  ]));
}
export function logSeverity(value: unknown, message: string): LogSeverity {
  const named = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["fatal", "panic", "error", "err"].includes(named)) return "error";
  if (["warning", "warn"].includes(named)) return "warning";
  if (["debug", "trace"].includes(named)) return "debug";
  if (["info", "notice"].includes(named)) return "info";
  const priority = typeof value === "number" ? value : /^[0-7]$/.test(named) ? Number(named) : Number.NaN;
  if (Number.isInteger(priority) && priority >= 0 && priority <= 7) {
    if (priority <= 3) return "error";
    if (priority === 4) return "warning";
    if (priority === 7) return "debug";
  }
  if (/\b(error|fatal|panic)\b/i.test(message)) return "error";
  if (/\bwarn(?:ing)?\b/i.test(message)) return "warning";
  return "info";
}

export function logTimestamp(value: unknown): string | null {
  const millis = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis) || Math.abs(millis) > 8_640_000_000_000_000) return null;
  return new Date(millis).toISOString();
}

export interface JournalLogRecord {
  cursor: string;
  micros: bigint;
  timestamp: string;
  unit: string;
  message: string;
  severity: LogSeverity;
}

function journalMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const bytes: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) return null;
    bytes.push(item);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch { return null; }
}

export function parseJournalLogRecord(value: unknown): JournalLogRecord | null {
  if (!isRecord(value) || typeof value.__CURSOR !== "string" || !value.__CURSOR
    || value.__CURSOR.length > 1024 || /[\r\n\0]/.test(value.__CURSOR)
    || typeof value._SYSTEMD_UNIT !== "string" || !value._SYSTEMD_UNIT
    || typeof value.__REALTIME_TIMESTAMP !== "string" || !/^\d{1,20}$/.test(value.__REALTIME_TIMESTAMP)) return null;
  const micros = BigInt(value.__REALTIME_TIMESTAMP);
  if (micros > 18_446_744_073_709_551_615n) return null;
  const timestamp = logTimestamp(Number(micros / 1000n));
  const message = journalMessage(value.MESSAGE);
  if (timestamp === null || !message) return null;
  return {
    cursor: value.__CURSOR, micros, timestamp, unit: value._SYSTEMD_UNIT,
    message: redactLogMessage(message), severity: logSeverity(value.PRIORITY, message),
  };
}
