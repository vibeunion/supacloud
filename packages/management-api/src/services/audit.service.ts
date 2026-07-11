import { sql } from "../db";
import { extractProjectRefFromPath } from "../utils/project-auth";
import { logger } from "../utils/logger";
import { resolveProxyClientIp } from "../utils/client-ip";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const AUDIT_FLUSH_INTERVAL_MS = positiveInteger(process.env.AUDIT_FLUSH_INTERVAL_MS, 100);
const AUDIT_BATCH_SIZE = positiveInteger(process.env.AUDIT_BATCH_SIZE, 25);
const AUDIT_QUEUE_MAX_SIZE = Math.max(
  AUDIT_BATCH_SIZE,
  positiveInteger(process.env.AUDIT_QUEUE_MAX_SIZE, 256),
);
const AUDIT_DROP_WARN_INTERVAL_MS = positiveInteger(
  process.env.AUDIT_DROP_WARN_INTERVAL_MS,
  60_000,
);

type AuditInput = {
  request: Request;
  status?: number;
  action?: string;
  metadata?: Record<string, unknown>;
};

const auditQueue: AuditInput[] = [];
let auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
let auditFlushInFlight = false;
let droppedAuditEvents = 0;
let lastAuditDropWarningAt = 0;

export function enqueueBoundedAuditEvent<T>(
  queue: T[],
  input: T,
  maxSize: number,
  onDrop: () => void = () => undefined,
): boolean {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new Error("Audit queue max size must be a positive integer");
  }
  if (queue.length >= maxSize) {
    onDrop();
    return false;
  }
  queue.push(input);
  return true;
}

function reportDroppedAuditEvent(): void {
  droppedAuditEvents += 1;
  const timestamp = Date.now();
  if (timestamp - lastAuditDropWarningAt < AUDIT_DROP_WARN_INTERVAL_MS) return;
  logger.warn("Audit queue is full; dropping new audit events", {
    droppedEvents: droppedAuditEvents,
    queueLimit: AUDIT_QUEUE_MAX_SIZE,
  });
  droppedAuditEvents = 0;
  lastAuditDropWarningAt = timestamp;
}

function actorFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return `bearer:${auth.slice(7, 19)}`;
  return "anonymous";
}

export function shouldAuditRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname.startsWith("/v1") && WRITE_METHODS.has(request.method.toUpperCase());
}

function scheduleAuditFlush(): void {
  if (auditFlushTimer) return;
  auditFlushTimer = setTimeout(() => {
    auditFlushTimer = null;
    void flushAuditEvents();
  }, AUDIT_FLUSH_INTERVAL_MS);
  auditFlushTimer.unref?.();
}

async function writeAuditEvent(input: AuditInput) {
  try {
    const url = new URL(input.request.url);
    const action = input.action || `${input.request.method.toUpperCase()} ${url.pathname}`;
    const projectRef = extractProjectRefFromPath(url.pathname);
    await sql`
      INSERT INTO audit_logs (project_ref, actor, action, method, path, status, ip_address, user_agent, request_id, metadata)
      VALUES (
        ${projectRef},
        ${actorFromRequest(input.request)},
        ${action},
        ${input.request.method.toUpperCase()},
        ${url.pathname},
        ${input.status || null},
        ${resolveProxyClientIp(input.request)},
        ${input.request.headers.get("user-agent") || ""},
        ${input.request.headers.get("x-request-id") || crypto.randomUUID()},
        ${JSON.stringify(input.metadata || {})}
      )
    `;
  } catch (error: unknown) {
    logger.warn("Failed to write audit log", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function flushAuditEvents(): Promise<void> {
  if (auditFlushInFlight) {
    scheduleAuditFlush();
    return;
  }

  auditFlushInFlight = true;
  try {
    while (auditQueue.length > 0) {
      const batch = auditQueue.splice(0, AUDIT_BATCH_SIZE);
      for (const event of batch) {
        await writeAuditEvent(event);
      }
    }
  } finally {
    auditFlushInFlight = false;
    if (auditQueue.length > 0) scheduleAuditFlush();
  }
}

export async function logAuditEvent(input: AuditInput) {
  if (!enqueueBoundedAuditEvent(
    auditQueue,
    input,
    AUDIT_QUEUE_MAX_SIZE,
    reportDroppedAuditEvent,
  )) return;
  if (auditQueue.length >= AUDIT_BATCH_SIZE) {
    void flushAuditEvents();
  } else {
    scheduleAuditFlush();
  }
}

export async function flushAuditEventsForTests(): Promise<void> {
  if (auditFlushTimer) {
    clearTimeout(auditFlushTimer);
    auditFlushTimer = null;
  }
  await flushAuditEvents();
}
