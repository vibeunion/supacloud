/** Public output events are separate from internal workflow logs and Webhooks. */
export const TASK_OUTPUT_EVENT_BYTES = 16 * 1024;
export const TASK_OUTPUT_REQUEST_BYTES = 20 * 1024;
export const TASK_OUTPUT_PAGE_LIMIT = 100;
export const TASK_OUTPUT_TYPES = ["output.delta", "output.snapshot", "progress", "warning"] as const;
export type TaskOutputType = typeof TASK_OUTPUT_TYPES[number];

export class TaskOutputError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "TaskOutputError";
  }
}

export interface AppendTaskOutput {
  attempt: number;
  event_id: string;
  type: TaskOutputType;
  payload: Record<string, unknown>;
}

const MAX_CURSOR = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskOutputScope(projectRef: unknown, taskId: unknown): { projectRef: string; taskId: string } {
  if (typeof projectRef !== "string" || !/^[a-zA-Z0-9_-]{1,20}$/.test(projectRef)
    || typeof taskId !== "string" || !UUID.test(taskId)) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Invalid project or task identifier");
  }
  return { projectRef, taskId: taskId.toLowerCase() };
}

/** Used only to let authenticated users reach the resource-level read check. */
export function isTaskOutputReadRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const match = /^\/v1\/projects\/([a-zA-Z0-9_-]{1,20})\/tasks\/([^/]+)\/events\/?$/.exec(new URL(request.url).pathname);
  return !!match && UUID.test(match[2]);
}

export async function resolveTaskOutputInvoker(
  request: Request,
  verify: (token: string, ref: string) => Promise<{ ref: string; role: string; sub?: string } | null>,
  delegated: boolean,
  expectedRef?: string,
): Promise<string | null> {
  if (!isTaskOutputReadRequest(request) || delegated) return null;
  const ref = new URL(request.url).pathname.split("/")[3];
  if (expectedRef !== undefined && expectedRef !== ref) return null;
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const jwt = await verify(authorization.slice(7).trim(), ref);
  return jwt?.ref === ref && jwt.role === "authenticated" && typeof jwt.sub === "string" && UUID.test(jwt.sub)
    ? jwt.sub.toLowerCase() : null;
}

export function taskOutputCursor(value: unknown = "0"): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > MAX_CURSOR) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_CURSOR", "Cursor must be a canonical PostgreSQL bigint decimal string");
  }
  return value;
}

export function taskOutputQuery(url: URL): { after: string; limit: number } {
  if (url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Duplicate pagination parameters");
  }
  const after = taskOutputCursor(url.searchParams.get("after") ?? "0");
  const raw = url.searchParams.get("limit") ?? "50";
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > TASK_OUTPUT_PAGE_LIMIT) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "limit must be between 1 and 100");
  }
  return { after, limit: Number(raw) };
}

export function parseTaskOutput(value: unknown): AppendTaskOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Expected an event object");
  }
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.attempt) || Number(input.attempt) < 1 || Number(input.attempt) > 2147483647
    || typeof input.event_id !== "string" || !UUID.test(input.event_id)
    || !TASK_OUTPUT_TYPES.includes(input.type as TaskOutputType)
    || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Invalid attempt, event_id, type or payload");
  }
  let encoded: string;
  try { encoded = JSON.stringify(input.payload); } catch {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Payload must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > TASK_OUTPUT_EVENT_BYTES) {
    throw new TaskOutputError(413, "TASK_OUTPUT_LIMIT", "Output event exceeds 16 KiB");
  }
  let snapshot: unknown;
  try { snapshot = JSON.parse(encoded); } catch {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Payload must be JSON serializable");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Payload must encode an object");
  }
  return { attempt: Number(input.attempt), event_id: input.event_id.toLowerCase(), type: input.type as TaskOutputType, payload: snapshot as Record<string, unknown> };
}

/** Authenticate before calling this reader; do not let Elysia preparse the body. */
export async function readTaskOutputBody(request: Request): Promise<AppendTaskOutput> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new TaskOutputError(415, "TASK_OUTPUT_INVALID_INPUT", "Content-Type must be application/json");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > TASK_OUTPUT_REQUEST_BYTES)) {
    throw new TaskOutputError(413, "TASK_OUTPUT_LIMIT", "Request body exceeds 20 KiB");
  }
  if (!request.body) throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new TaskOutputError(408, "TASK_OUTPUT_BODY_TIMEOUT", "Request body timed out")), 10_000);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      length += value.byteLength;
      if (length > TASK_OUTPUT_REQUEST_BYTES || chunks.length >= 512) {
        throw new TaskOutputError(413, "TASK_OUTPUT_LIMIT", "Request body exceeds limits");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
      throw new TaskOutputError(400, "TASK_OUTPUT_INVALID_INPUT", "Invalid JSON body");
    }
    return parseTaskOutput(body);
  } finally {
    clearTimeout(timeout);
    // Never wait for an uncooperative producer while rejecting a request.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
