import { createHash, randomBytes } from "node:crypto";

export interface TaskTraceEnvelope {
  project_ref: string;
  traceparent: string;
  request_id: string;
}

export function parseTaskTraceparent(value: unknown) {
  const match = typeof value === "string"
    ? value.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/)
    : null;
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]!, flags: (parseInt(match[3]!, 16) & 1) ? "01" : "00" };
}

export function taskAttemptTrace(
  task: { id: string; project_ref: string; trace_id?: string | null; payload?: Record<string, unknown> },
): Headers {
  const envelope = task.payload?.trace as Partial<TaskTraceEnvelope> | undefined;
  let traceId: string;
  let flags = "00";
  if (envelope !== undefined) {
    const parent = parseTaskTraceparent(envelope?.traceparent);
    if (!parent || envelope?.project_ref !== task.project_ref
      || typeof envelope.request_id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(envelope.request_id)
      || parent.traceId !== task.trace_id) {
      throw new Error("Background trace identity is inconsistent");
    }
    traceId = parent.traceId;
    flags = parent.flags;
  } else {
    // Stable fallback for legacy UUID trace IDs; never inherit payload headers.
    traceId = createHash("sha256").update(JSON.stringify([
      task.project_ref, task.id, task.trace_id ?? "",
    ])).digest("hex").slice(0, 32);
  }
  return new Headers({
    traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-${flags}`,
    "x-supacloud-trace-id": traceId,
    "x-request-id": randomBytes(16).toString("hex"),
  });
}
