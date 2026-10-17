import { describe, expect, test } from "bun:test";
import { buildTaskEventEnvelope, buildWebhookEventEnvelope, eventKindForTask } from "../../src/services/event-envelope";

describe("unified event envelope", () => {
  test("classifies existing execution backends without replacing them", () => {
    expect(eventKindForTask("queue:emails", null)).toBe("queue");
    expect(eventKindForTask("pgflow", null)).toBe("workflow");
    expect(eventKindForTask("edge_function", "cron-nightly")).toBe("cron");
    expect(eventKindForTask("edge_function", "send-email")).toBe("database");
  });

  test("keeps task retry and idempotency controls in the shared contract", () => {
    const event = buildTaskEventEnvelope({
      eventId: "task-1:running",
      projectRef: "demo",
      taskId: "task-1",
      taskType: "queue:emails",
      functionSlug: null,
      status: "retry_scheduled",
      occurredAt: "2026-10-07T00:00:00.000Z",
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: "2026-10-07T00:01:00.000Z",
      error: "timeout",
      correlationId: "case-1",
      idempotencyKey: "send:case-1",
    });
    expect(event).toMatchObject({
      schema: "supacloud.event.v1",
      kind: "queue",
      retry: { attempt: 2, max_attempts: 5, dead_lettered: false },
      correlation_id: "case-1",
      idempotency_key: "send:case-1",
    });
  });

  test("exposes webhook signing metadata without exposing secrets", () => {
    const event = buildWebhookEventEnvelope({
      eventId: "evt-1",
      projectRef: "demo",
      outboxId: "outbox-1",
      eventType: "invoice.created",
      status: "delivered",
      occurredAt: "2026-10-07T00:00:00.000Z",
      attempt: 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      error: null,
      idempotencyKey: "invoice:1",
      signatureVersion: "v1",
      signatureTimestamp: "2026-10-07T00:00:00.000Z",
      secretVersion: 3,
      payload: { invoice_id: "1" },
    });
    expect(event.signature).toEqual({
      version: "v1",
      timestamp: "2026-10-07T00:00:00.000Z",
      secret_version: 3,
    });
    expect(JSON.stringify(event)).not.toContain("super-secret-value");
  });
});
