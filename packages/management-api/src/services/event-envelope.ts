export type UnifiedEventKind = "database" | "cron" | "webhook" | "queue" | "workflow";
export type UnifiedEventStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "retry_scheduled"
  | "dead_lettered"
  | "cancelled"
  | "delivered";

export interface UnifiedEventEnvelope {
  schema: "supacloud.event.v1";
  event_id: string;
  project_ref: string;
  kind: UnifiedEventKind;
  type: string;
  status: UnifiedEventStatus | string;
  occurred_at: string;
  source_id: string;
  correlation_id: string | null;
  idempotency_key: string | null;
  retry: {
    attempt: number;
    max_attempts: number;
    next_attempt_at: string | null;
    dead_lettered: boolean;
    last_error: string | null;
  };
  signature: {
    version: string | null;
    timestamp: string | null;
    secret_version: number | null;
  };
  audit: {
    action: string | null;
    actor: string | null;
    request_id: string | null;
  };
  data: Record<string, unknown>;
}

export function eventKindForTask(taskType: string, functionSlug: string | null): UnifiedEventKind {
  if (taskType === "cron" || taskType.startsWith("cron:") || functionSlug?.startsWith("cron")) return "cron";
  if (taskType === "pgflow" || taskType.startsWith("workflow:") || taskType.startsWith("pgflow:")) return "workflow";
  return taskType.startsWith("queue:") || taskType === "queue" ? "queue" : "database";
}

export function taskEventType(status: string): string {
  return `task.${status}`;
}

export function buildTaskEventEnvelope(input: {
  eventId: string;
  projectRef: string;
  taskId: string;
  taskType: string;
  functionSlug: string | null;
  status: string;
  occurredAt: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  metadata?: Record<string, unknown> | null;
}): UnifiedEventEnvelope {
  return {
    schema: "supacloud.event.v1",
    event_id: input.eventId,
    project_ref: input.projectRef,
    kind: eventKindForTask(input.taskType, input.functionSlug),
    type: taskEventType(input.status),
    status: input.status,
    occurred_at: input.occurredAt,
    source_id: input.taskId,
    correlation_id: input.correlationId,
    idempotency_key: input.idempotencyKey,
    retry: {
      attempt: input.attempt,
      max_attempts: input.maxAttempts,
      next_attempt_at: input.nextAttemptAt,
      dead_lettered: input.status === "dead_lettered",
      last_error: input.error,
    },
    signature: { version: null, timestamp: null, secret_version: null },
    audit: { action: null, actor: null, request_id: null },
    data: { task_id: input.taskId, task_type: input.taskType, function_slug: input.functionSlug, ...(input.metadata ?? {}) },
  };
}

export function buildWebhookEventEnvelope(input: {
  eventId: string;
  projectRef: string;
  outboxId: string;
  eventType: string;
  status: string;
  occurredAt: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  idempotencyKey: string | null;
  signatureVersion: string | null;
  signatureTimestamp: string | null;
  secretVersion: number | null;
  payload: Record<string, unknown>;
}): UnifiedEventEnvelope {
  return {
    schema: "supacloud.event.v1",
    event_id: input.eventId,
    project_ref: input.projectRef,
    kind: "webhook",
    type: input.eventType,
    status: input.status,
    occurred_at: input.occurredAt,
    source_id: input.outboxId,
    correlation_id: null,
    idempotency_key: input.idempotencyKey,
    retry: {
      attempt: input.attempt,
      max_attempts: input.maxAttempts,
      next_attempt_at: input.nextAttemptAt,
      dead_lettered: input.status === "dead_lettered",
      last_error: input.error,
    },
    signature: {
      version: input.signatureVersion,
      timestamp: input.signatureTimestamp,
      secret_version: input.secretVersion,
    },
    audit: { action: "webhook.delivery", actor: null, request_id: null },
    data: input.payload,
  };
}
