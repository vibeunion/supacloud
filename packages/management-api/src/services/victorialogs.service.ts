export type ProjectLogQuery = {
  service?: string;
  search?: string;
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
};

export type VictoriaProjectLog = {
  id: string;
  timestamp: string;
  event_message: string;
  severity: "debug" | "info" | "warning" | "error";
  service: string;
  metadata: Record<string, unknown>;
};

export type VictoriaLogWrite = {
  timestamp: string;
  message: string;
  service: string;
  projectRef?: string;
  severity?: "debug" | "info" | "warning" | "error";
  unit?: string;
};

type VictoriaLogsServiceOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9_.@-]{1,128}$/;

function logsQlLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 200;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error("Log query limit must be an integer between 1 and 1000");
  }
  return value;
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error("Log query offset must be an integer between 0 and 1000000");
  }
  return value;
}

function normalizeTimestamp(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function severityFor(record: Record<string, unknown>, message: string): VictoriaProjectLog["severity"] {
  const explicit = String(record.severity ?? record.level ?? "").toLowerCase();
  if (["fatal", "panic", "error", "err"].includes(explicit)) return "error";
  if (["warning", "warn"].includes(explicit)) return "warning";
  if (["debug", "trace"].includes(explicit)) return "debug";
  const priority = Number(record.PRIORITY ?? record.priority);
  if (Number.isFinite(priority)) {
    if (priority <= 3) return "error";
    if (priority === 4) return "warning";
    if (priority >= 7) return "debug";
  }
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("fatal") || lowerMessage.includes("error")) return "error";
  if (lowerMessage.includes("warn")) return "warning";
  return "info";
}

function parseJsonLines(payload: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of payload.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // VictoriaLogs may terminate a response while a client closes it. Ignore only malformed lines.
    }
  }
  return records;
}

export class VictoriaLogsService {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: VictoriaLogsServiceOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.VICTORIALOGS_URL || "http://127.0.0.1:9428").replace(/\/+$/, "");
    this.fetcher = options.fetcher || fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async queryProjectLogs(ref: string, input: ProjectLogQuery): Promise<VictoriaProjectLog[]> {
    if (!PROJECT_REF_PATTERN.test(ref)) throw new Error("Invalid project ref");
    if (input.service && input.service !== "all" && !SERVICE_PATTERN.test(input.service)) {
      throw new Error("Invalid log service filter");
    }
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const start = normalizeTimestamp(input.start, "start");
    const end = normalizeTimestamp(input.end, "end");
    if (start && end && Date.parse(start) >= Date.parse(end)) throw new Error("start must be earlier than end");

    const filters = [`project_ref:=${logsQlLiteral(ref)}`];
    if (input.service && input.service !== "all") filters.push(`service:=${logsQlLiteral(input.service)}`);
    if (input.search?.trim()) filters.push(logsQlLiteral(input.search.trim()));

    const body = new URLSearchParams({
      query: filters.join(" "),
      limit: String(limit),
      offset: String(offset),
      timeout: `${Math.max(1, Math.ceil(this.timeoutMs / 1000))}s`,
    });
    if (start) body.set("start", start);
    if (end) body.set("end", end);

    const response = await this.fetcher(`${this.baseUrl}/select/logsql/query`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`VictoriaLogs query failed (${response.status})`);
    }

    return parseJsonLines(await response.text()).slice(0, limit).map((record, index) => {
      const message = String(record._msg ?? record.message ?? record.MESSAGE ?? "");
      const rawTimestamp = String(record._time ?? record.timestamp ?? new Date().toISOString());
      const timestamp = Number.isFinite(Date.parse(rawTimestamp)) ? new Date(rawTimestamp).toISOString() : new Date().toISOString();
      const service = String(record.service ?? record.SYSLOG_IDENTIFIER ?? record._SYSTEMD_UNIT ?? "system");
      return {
        id: String(record.id ?? `${ref}-${timestamp}-${index}`),
        timestamp,
        event_message: message,
        severity: severityFor(record, message),
        service,
        metadata: record,
      };
    });
  }

  async ingest(events: readonly VictoriaLogWrite[]): Promise<void> {
    if (events.length === 0) return;
    const payload = events.map((event) => JSON.stringify({
      _time: event.timestamp,
      _msg: event.message,
      service: event.service,
      project_ref: event.projectRef || "",
      severity: event.severity || "info",
      _SYSTEMD_UNIT: event.unit || "supacloud-edge-function",
    })).join("\n");
    const response = await this.fetcher(`${this.baseUrl}/insert/jsonline`, {
      method: "POST",
      headers: { "content-type": "application/stream+json" },
      body: `${payload}\n`,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`VictoriaLogs ingest failed (${response.status})`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2_000)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const victoriaLogsService = new VictoriaLogsService();
export const victoriaLogsInternals = { logsQlLiteral, parseJsonLines, severityFor };
