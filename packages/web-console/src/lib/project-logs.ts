export type ProjectLogSeverity = "debug" | "info" | "warning" | "error";
export interface ProjectLogEntry {
  id: string;
  timestamp: string;
  event_message: string;
  service: string;
  severity: ProjectLogSeverity;
}

export interface ProjectLogsResponse {
  entries: ProjectLogEntry[];
  sources: string[];
}

export class InvalidProjectLogsResponse extends Error {
  constructor() { super("Invalid project logs response"); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProjectLogsResponse(
  value: unknown,
  expected: { projectRef: string; limit: number; offset: number },
): ProjectLogsResponse {
  if (!record(value) || value.backend !== "victorialogs" || value.project_ref !== expected.projectRef
    || typeof value.live_stream !== "boolean" || !Array.isArray(value.result) || !Array.isArray(value.sources)
    || !record(value.pagination) || value.pagination.limit !== expected.limit
    || value.pagination.offset !== expected.offset || value.pagination.total !== value.result.length
    || value.result.length > expected.limit) throw new InvalidProjectLogsResponse();
  const sources: string[] = [];
  const rawSources: unknown[] = value.sources;
  for (const source of rawSources) {
    if (typeof source !== "string" || !/^[A-Za-z0-9_.@-]{1,128}$/.test(source) || sources.includes(source)) {
      throw new InvalidProjectLogsResponse();
    }
    sources.push(source);
  }
  const ids = new Set<string>();
  const entries: ProjectLogEntry[] = [];
  const rawEntries: unknown[] = value.result;
  for (const entry of rawEntries) {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)
      || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))
      || new Date(entry.timestamp).toISOString() !== entry.timestamp
      || typeof entry.event_message !== "string" || typeof entry.service !== "string"
      || !/^[A-Za-z0-9_.@-]{1,128}$/.test(entry.service)
      || (entry.severity !== "debug" && entry.severity !== "info" && entry.severity !== "warning" && entry.severity !== "error")
      || !record(entry.metadata) || entry.metadata.project_ref !== expected.projectRef) {
      throw new InvalidProjectLogsResponse();
    }
    ids.add(entry.id);
    entries.push({
      id: entry.id, timestamp: entry.timestamp, event_message: entry.event_message,
      service: entry.service, severity: entry.severity,
    });
  }
  return { entries, sources };
}

export async function readProjectLogsResponse(
  response: Response,
  expected: { projectRef: string; limit: number; offset: number },
  signal: AbortSignal,
): Promise<ProjectLogsResponse> {
  const maxBytes = 8 * 1024 * 1024;
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const length = response.headers.get("content-length");
    if (!response.ok || !reader || (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes)) {
      throw new InvalidProjectLogsResponse();
    }
    let bytes = new Uint8Array(64 * 1024);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > maxBytes) throw new InvalidProjectLogsResponse();
      size += value.byteLength;
      if (size > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(size, bytes.byteLength * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(value, size - value.byteLength);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } catch { throw new InvalidProjectLogsResponse(); }
    return parseProjectLogsResponse(payload, expected);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}
