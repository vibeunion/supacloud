import { sql } from "../db";
import { buildTaskEventEnvelope, buildWebhookEventEnvelope, type UnifiedEventEnvelope } from "./event-envelope";

type EventRow = Record<string, unknown>;

function encodeCursor(event: UnifiedEventEnvelope): string {
  return Buffer.from(JSON.stringify({
    occurred_at: event.occurred_at,
    event_id: event.event_id,
  })).toString("base64url");
}

function decodeCursor(value: string | undefined): { occurredAt: string; eventId: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.occurred_at !== "string" || typeof parsed.event_id !== "string"
      || !parsed.event_id || !Number.isFinite(Date.parse(parsed.occurred_at))) return null;
    return { occurredAt: parsed.occurred_at, eventId: parsed.event_id };
  } catch {
    return null;
  }
}

function text(row: EventRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function integer(row: EventRow, key: string, fallback: number): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function listUnifiedEvents(input: {
  projectRef: string;
  kind?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ events: UnifiedEventEnvelope[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const cursor = decodeCursor(input.cursor);
  const kind = input.kind ?? null;
  const eventStatus = input.status ?? null;
  const rows = await sql`
    SELECT *
    FROM (
      SELECT
        'task'::text AS source_kind, id::text AS source_id, id::text || ':' || status AS event_id,
        project_ref, task_type, function_slug, status, updated_at AS occurred_at,
        attempt, max_attempts, next_run_at AS next_attempt_at, error,
        correlation_id, idempotency_key, metadata, NULL::text AS event_type,
        NULL::jsonb AS webhook_payload, NULL::text AS signature_version,
        NULL::text AS signature_timestamp, NULL::int AS secret_version,
        NULL::text AS audit_action, NULL::text AS audit_actor, NULL::text AS request_id
      FROM project_tasks
      WHERE project_ref = ${input.projectRef}
        AND (${eventStatus}::text IS NULL OR status = ${eventStatus})
        AND (${kind}::text IS NULL OR (
          CASE
            WHEN task_type = 'cron' OR task_type LIKE 'cron:%' OR function_slug LIKE 'cron%' THEN 'cron'
            WHEN task_type = 'pgflow' OR task_type LIKE 'workflow:%' OR task_type LIKE 'pgflow:%' THEN 'workflow'
            WHEN task_type = 'queue' OR task_type LIKE 'queue:%' THEN 'queue'
            ELSE 'database'
          END
        ) = ${kind})
      UNION ALL
      SELECT
        'task'::text, task.id::text, task.id::text || ':attempt:' || attempts.attempt_no::text
          || ':' || attempts.status,
        task.project_ref, task.task_type, task.function_slug, attempts.status,
        COALESCE(attempts.completed_at, attempts.started_at), attempts.attempt_no,
        task.max_attempts, task.next_run_at, attempts.error, task.correlation_id,
        task.idempotency_key, jsonb_build_object(
          'attempt_id', attempts.id,
          'response_status', attempts.response_status
        ) || COALESCE(task.metadata, '{}'::jsonb), NULL::text,
        NULL::jsonb, NULL::text, NULL::text, NULL::int,
        NULL::text, NULL::text, NULL::text
      FROM project_tasks task
      JOIN project_task_attempts attempts ON attempts.task_id = task.id
      WHERE task.project_ref = ${input.projectRef}
        AND (${eventStatus}::text IS NULL OR attempts.status = ${eventStatus})
        AND (${kind}::text IS NULL OR (
          CASE
            WHEN task.task_type = 'cron' OR task.task_type LIKE 'cron:%' OR task.function_slug LIKE 'cron%' THEN 'cron'
            WHEN task.task_type = 'pgflow' OR task.task_type LIKE 'workflow:%' OR task.task_type LIKE 'pgflow:%' THEN 'workflow'
            WHEN task.task_type = 'queue' OR task.task_type LIKE 'queue:%' THEN 'queue'
            ELSE 'database'
          END
        ) = ${kind})
      UNION ALL
      SELECT
        'webhook'::text, outbox.id::text, outbox.event_id::text, outbox.project_ref,
        NULL::text, NULL::text, outbox.status, outbox.occurred_at,
        outbox.attempt_count, outbox.max_attempts, outbox.next_attempt_at, outbox.last_error,
        NULL::text, outbox.idempotency_key, '{}'::jsonb, outbox.event_type,
        outbox.payload, deliveries.signature_version, deliveries.signature_timestamp,
        deliveries.secret_version, 'webhook.delivery', outbox.created_by, NULL::text
      FROM webhook_outbox outbox
      LEFT JOIN LATERAL (
        SELECT signature_version, signature_timestamp, secret_version
        FROM webhook_deliveries
        WHERE outbox_id = outbox.id
        ORDER BY attempt DESC
        LIMIT 1
      ) deliveries ON true
      WHERE outbox.project_ref = ${input.projectRef}
        AND (${eventStatus}::text IS NULL OR outbox.status = ${eventStatus})
        AND (${kind}::text IS NULL OR ${kind} = 'webhook')
    ) events
    WHERE (
      ${cursor?.occurredAt ?? null}::timestamptz IS NULL
      OR occurred_at < ${cursor?.occurredAt ?? null}::timestamptz
      OR (occurred_at = ${cursor?.occurredAt ?? null}::timestamptz AND event_id < ${cursor?.eventId ?? null})
    )
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT ${Math.min(limit + 1, 201)}
  ` as EventRow[];

  const events = rows
    .map((row) => {
      const sourceKind = text(row, "source_kind");
      if (sourceKind === "webhook") {
        return buildWebhookEventEnvelope({
          eventId: text(row, "event_id") ?? "",
          projectRef: text(row, "project_ref") ?? input.projectRef,
          outboxId: text(row, "source_id") ?? "",
          eventType: text(row, "event_type") ?? "webhook.delivery",
          status: text(row, "status") ?? "failed",
          occurredAt: text(row, "occurred_at") ?? new Date(0).toISOString(),
          attempt: integer(row, "attempt", 0),
          maxAttempts: integer(row, "max_attempts", 0),
          nextAttemptAt: text(row, "next_attempt_at"),
          error: text(row, "error"),
          idempotencyKey: text(row, "idempotency_key"),
          signatureVersion: text(row, "signature_version"),
          signatureTimestamp: text(row, "signature_timestamp"),
          secretVersion: row.secret_version === null ? null : integer(row, "secret_version", 0),
          payload: jsonObject(row.webhook_payload),
        });
      }
      return buildTaskEventEnvelope({
        eventId: text(row, "event_id") ?? "",
        projectRef: text(row, "project_ref") ?? input.projectRef,
        taskId: text(row, "source_id") ?? "",
        taskType: text(row, "task_type") ?? "unknown",
        functionSlug: text(row, "function_slug"),
        status: text(row, "status") ?? "unknown",
        occurredAt: text(row, "occurred_at") ?? new Date(0).toISOString(),
        attempt: integer(row, "attempt", 0),
        maxAttempts: integer(row, "max_attempts", 0),
        nextAttemptAt: text(row, "next_attempt_at"),
        error: text(row, "error"),
        correlationId: text(row, "correlation_id"),
        idempotencyKey: text(row, "idempotency_key"),
        metadata: jsonObject(row.metadata),
      });
    })
    ;

  const page = events.slice(0, limit);
  return {
    events: page,
    next_cursor: events.length > limit && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
  };
}
