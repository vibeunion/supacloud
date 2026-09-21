import { LOG_PROJECT_REF_PATTERN, parseJournalLogRecord } from "./log-record";

export const MAX_PROJECT_LOG_LINE_BYTES = 1_048_576;

export function normalizePersistedLogService(service?: string): string | undefined {
  switch (service) {
    case "api": return "postgrest";
    case "gotrue": return "auth";
    case "db": return "database";
    case "postgres": return "database";
    default: return service || undefined;
  }
}

export function getProjectLogUnits(ref: string, service?: string): string[] {
  if (typeof ref !== "string" || !LOG_PROJECT_REF_PATTERN.test(ref)) throw new Error("Invalid project ref");
  const units = new Map([
    ["auth", `supacloud-gotrue@${ref}`],
    ["postgrest", `supacloud-pgrst@${ref}`],
    ["database", `supacloud-postgres@${ref}`],
    ["storage", `supacloud-storage@${ref}`],
  ]);
  if (!service || service === "all") return [...units.values()];
  const unit = units.get(normalizePersistedLogService(service) ?? "");
  if (!unit) throw new Error("Live log streaming only supports project-isolated auth, api, database, and storage services");
  return [unit];
}

async function* journalLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const line = new Uint8Array(MAX_PROJECT_LOG_LINE_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let oversized = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (!(value instanceof Uint8Array) || value.byteLength > MAX_PROJECT_LOG_LINE_BYTES) {
      throw new Error("Invalid journal stream chunk");
    }
    let position = 0;
    while (position < value.byteLength) {
      const newline = value.indexOf(10, position);
      const end = newline === -1 ? value.byteLength : newline;
      const length = end - position;
      if (!oversized && size + length <= line.byteLength) {
        line.set(value.subarray(position, end), size);
        size += length;
      } else {
        oversized = true;
      }
      if (newline === -1) break;
      let text: string | undefined;
      if (!oversized) {
        try { text = decoder.decode(line.subarray(0, size)); } catch { /* Invalid UTF-8 is not a log event. */ }
      }
      size = 0;
      oversized = false;
      position = newline + 1;
      if (text !== undefined) yield text;
    }
  }
}

export function createProjectLogStream(
  source: ReadableStream<Uint8Array>,
  ref: string,
  service: string | undefined,
  options: { signal: AbortSignal; onClose: () => void },
): ReadableStream<Uint8Array> {
  const units = new Set(getProjectLogUnits(ref, service).map((unit) => `${unit}.service`));
  const reader = source.getReader();
  const lines = journalLines(reader);
  const encoder = new TextEncoder();
  let closed = false;
  let closeOutput = () => {};
  const abort = () => finish(true);
  function finish(close: boolean) {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", abort);
    // Cancel first to settle a pending read; cleanup must not wait on an external producer.
    void reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
    options.onClose();
    if (close) closeOutput();
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      closeOutput = () => controller.close();
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) { finish(true); return; }
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    async pull(controller) {
      try {
        while (!closed) {
          const { done, value } = await lines.next();
          if (closed) return;
          if (done) { finish(true); return; }
          let raw: unknown;
          try { raw = JSON.parse(value); } catch { continue; }
          const record = parseJournalLogRecord(raw);
          if (!record || !units.has(record.unit)) continue;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            timestamp: record.timestamp,
            service: record.unit,
            message: record.message,
            severity: record.severity,
          })}\n\n`));
          return;
        }
      } catch {
        if (!closed) {
          finish(false);
          controller.error(new Error("Project log stream failed"));
        }
      }
    },
    cancel() { finish(false); },
  });
}
