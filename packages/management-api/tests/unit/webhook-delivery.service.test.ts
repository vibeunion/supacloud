import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

let claimedAttemptCount = 0;
let claimedOverrides: Record<string, unknown> = {};
let persistedQueries: Array<{ text: string; values: unknown[] }> = [];
let unfinishedOutboxCount = 0;
let matchingSubscriptionCount = 1;
let managedSecretAvailable = true;
const transactionArray = mock((values: string[], type: string) => ({ values, type }));
const controlArray = mock((values: string[], type: string) => ({ values, type }));

const webhookRow = {
  id: "11111111-1111-4111-8111-111111111111",
  project_ref: "proj_1",
  url: "https://hooks.example.com/events",
  events: ["user.created"],
  secret_version: 2,
  enabled: true,
  api_version: "2026-07-01",
};

const claimed = () => ({
  ...webhookRow,
  outbox_id: "22222222-2222-4222-8222-222222222222",
  event_id: "33333333-3333-4333-8333-333333333333",
  project_ref: "proj_1",
  event_type: "user.created",
  payload: { id: "user-one" },
  attempt_count: claimedAttemptCount,
  max_attempts: 5,
  event_created_at: new Date("2026-07-19T00:00:00.000Z"),
  occurred_at: new Date("2026-07-18T23:59:00.000Z"),
  outbox_api_version: "2026-07-01",
  ...claimedOverrides,
});

const originalDelivery = {
  id: "44444444-4444-4444-8444-444444444444",
  event_id: "33333333-3333-4333-8333-333333333333",
  event_type: "user.created",
  payload: { id: "user-one" },
  occurred_at: new Date("2026-07-18T23:59:00.000Z"),
  api_version: "2026-07-01",
};

const transactionQuery = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  persistedQueries.push({ text, values });
  if (text.includes("FROM webhook_outbox") && text.includes("FOR UPDATE")) return Promise.resolve([claimed()]);
  if (text.includes("SELECT * FROM project_webhooks")) return Promise.resolve([webhookRow]);
  if (text.includes("SELECT id FROM project_webhooks")) return Promise.resolve([{ id: webhookRow.id }]);
  if (text.includes("COUNT(*)::int AS count FROM project_webhooks")) return Promise.resolve([{ count: 1 }]);
  if (text.includes("COUNT(*)::int AS count FROM project_webhooks w")) return Promise.resolve([{ count: matchingSubscriptionCount }]);
  if (text.includes("COUNT(*)::int AS count FROM webhook_outbox")) return Promise.resolve([{ count: unfinishedOutboxCount }]);
  if (text.includes("SELECT value_encrypted") && text.includes("FROM project_control_secrets")) {
    return Promise.resolve(managedSecretAvailable ? [{ value_encrypted: "encrypted-secret" }] : []);
  }
  if (text.includes("FROM webhook_deliveries d")) return Promise.resolve([originalDelivery]);
  if (text.includes("INSERT INTO project_webhooks")) {
    return Promise.resolve([{ ...webhookRow, id: values[0], secret_version: 1 }]);
  }
  if (text.includes("INSERT INTO webhook_outbox")) {
    return Promise.resolve([{ id: "55555555-5555-4555-8555-555555555555", event_id: originalDelivery.event_id }]);
  }
  if (text.includes("UPDATE project_webhooks") && text.includes("secret_version = secret_version + 1")) {
    return Promise.resolve([{ ...webhookRow, secret_version: 3 }]);
  }
  if (text.includes("UPDATE project_webhooks")) return Promise.resolve([{ id: webhookRow.id, deleted_at: new Date() }]);
  return Promise.resolve([]);
});
const txMock = Object.assign(transactionQuery, { array: transactionArray });
const sqlQueryMock = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  persistedQueries.push({ text, values });
  if (text.includes("SELECT ref FROM projects")) return Promise.resolve([{ ref: "proj_1" }]);
  if (text.includes("SELECT * FROM project_webhooks")) return Promise.resolve([webhookRow]);
  if (text.includes("SELECT w.*") && text.includes("LEFT JOIN project_control_secrets")) {
    return Promise.resolve([{ ...webhookRow, has_secret: managedSecretAvailable }]);
  }
  if (text.includes("SELECT value_encrypted") && text.includes("FROM project_control_secrets")) {
    return Promise.resolve(managedSecretAvailable ? [{ value_encrypted: "encrypted-secret" }] : []);
  }
  if (text.includes("FROM webhook_deliveries d")) return Promise.resolve([originalDelivery]);
  if (text.includes("COUNT(*)::int AS count")) return Promise.resolve([{ count: 1 }]);
  return Promise.resolve([]);
});
const sqlMock = Object.assign(sqlQueryMock, {
  array: controlArray,
  begin: mock((callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
});

const databaseModule = await import("../../src/db");
mock.module("../../src/db", () => ({ ...databaseModule, sql: sqlMock }));
mock.module("../../src/routes/log-drains", () => ({
  isLogDrainUrlSafeForFetch: mock(() => Promise.resolve(true)),
  validateLogDrainUrl: mock((url: string) => ({ ok: true, url })),
}));
mock.module("../../src/utils/secret-crypto", () => ({
  decryptSecretIfNeeded: mock((value: string) => value === "encrypted-previous-secret" ? "previous-webhook-secret" : "webhook-secret"),
  encryptSecretIfNeeded: mock((value: string) => `encrypted:${value}`),
}));

const {
  enqueueWebhookEventInTransaction,
  processOneWebhookDelivery,
  webhookDeliveryService,
} = await import("../../src/services/webhook-delivery.service");

describe("durable webhook delivery processing", () => {
  beforeEach(() => {
    claimedAttemptCount = 0;
    claimedOverrides = {};
    persistedQueries = [];
    unfinishedOutboxCount = 0;
    matchingSubscriptionCount = 1;
    managedSecretAvailable = true;
    txMock.mockClear();
    transactionArray.mockClear();
    sqlQueryMock.mockClear();
    controlArray.mockClear();
    sqlMock.begin.mockClear();
  });

  test("sends versioned delivery headers and marks a successful outbox item delivered", async () => {
    let headers: Record<string, string> = {};
    let body = "";
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      body = String(init?.body || "");
      return new Response("ok", { status: 204 });
    }) as unknown as typeof fetch;
    expect(await processOneWebhookDelivery(fetchImpl)).toBe(true);
    expect(headers["X-SupaCloud-Delivery-Id"]).toBeTruthy();
    expect(headers["X-SupaCloud-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-SupaCloud-Key-Id"]).toBe("v2");
    expect(headers["X-SupaCloud-Signature"]).toMatch(/^v1=/);
    expect(JSON.parse(body)).toMatchObject({
      occurred_at: "2026-07-18T23:59:00.000Z",
      api_version: "2026-07-01",
    });
    expect(persistedQueries.some(({ values }) => values.includes("delivered"))).toBe(true);
    expect(persistedQueries.some(({ text }) => text.includes("request_body"))).toBe(true);
  });

  test("creates and rotates signing secrets only through managed storage", async () => {
    const created = await webhookDeliveryService.createWebhook(
      "proj_1",
      { url: "https://hooks.example.com/events", events: ["user.created"] },
      "admin-one",
    );
    expect(created).toMatchObject({ has_secret: true, signing_key_id: "v1" });
    expect(created).not.toHaveProperty("secret");
    const webhookInsert = persistedQueries.find(({ text }) => text.includes("INSERT INTO project_webhooks"));
    expect(webhookInsert?.text).not.toContain("secret_encrypted");
    expect(transactionArray).toHaveBeenCalledWith(["user.created"], "TEXT");
    expect(webhookInsert?.values).toContainEqual({ values: ["user.created"], type: "TEXT" });
    const managedInsert = persistedQueries.find(({ text }) => text.includes("INSERT INTO project_control_secrets"));
    expect(managedInsert?.values).toContain("webhook");
    expect(managedInsert?.values.some((storedValue) => String(storedValue).startsWith("encrypted:whsec_"))).toBe(true);

    persistedQueries = [];
    const rotated = await webhookDeliveryService.rotateSecret("proj_1", webhookRow.id);
    expect(rotated).toMatchObject({ has_secret: true, signing_key_id: "v3" });
    expect(rotated).not.toHaveProperty("secret");
    expect(persistedQueries.some(({ text }) => text.includes("previous_secret_encrypted"))).toBe(false);
    expect(persistedQueries.some(({ text }) => text.includes("INSERT INTO project_control_secrets"))).toBe(true);
  });

  test("updates webhook events with a typed array binding", async () => {
    await webhookDeliveryService.updateWebhook("proj_1", webhookRow.id, {
      events: ["user.created", "organization.created"],
    });

    expect(controlArray).toHaveBeenCalledWith(["user.created", "organization.created"], "TEXT");
    const webhookUpdate = persistedQueries.find(({ text }) => (
      text.includes("UPDATE project_webhooks") && text.includes("events =")
    ));
    expect(webhookUpdate?.values).toContainEqual({
      values: ["user.created", "organization.created"],
      type: "TEXT",
    });
  });

  test("preserves and binds stored events when events are omitted", async () => {
    await webhookDeliveryService.updateWebhook("proj_1", webhookRow.id, { enabled: false });

    expect(controlArray).toHaveBeenCalledWith(webhookRow.events, "TEXT");
    const webhookUpdate = persistedQueries.find(({ text }) => text.includes("UPDATE project_webhooks"));
    expect(webhookUpdate?.text).toContain("events =");
    expect(webhookUpdate?.values).toContainEqual({ values: webhookRow.events, type: "TEXT" });
  });

  test("rejects empty webhook events before binding or updating", async () => {
    await expect(webhookDeliveryService.updateWebhook(
      "proj_1",
      webhookRow.id,
      { events: [] },
    )).rejects.toThrow("events must not be empty");

    expect(controlArray).not.toHaveBeenCalled();
    expect(persistedQueries.some(({ text }) => text.includes("UPDATE project_webhooks"))).toBe(false);
  });

  test("reports managed secret status without reading or exposing the value", async () => {
    expect(await webhookDeliveryService.getWebhook("proj_1", webhookRow.id)).toMatchObject({ has_secret: true });
    expect(persistedQueries.some(({ text }) => text.includes("SELECT value_encrypted"))).toBe(false);

    managedSecretAvailable = false;
    persistedQueries = [];
    const listed = await webhookDeliveryService.listWebhooks("proj_1");
    expect(listed.items).toEqual([expect.objectContaining({ has_secret: false })]);
    expect(JSON.stringify(listed)).not.toContain("encrypted-secret");
  });

  test("replays with a new delivery id, current timestamp, current key, and replay header", async () => {
    claimedOverrides = {
      replay_of_delivery_id: originalDelivery.id,
      outbox_api_version: "2026-06-01",
    };
    let requestInit: RequestInit | undefined;
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      requestInit = init;
      return new Response("ok", { status: 204 });
    });

    expect(await processOneWebhookDelivery(fetchImpl)).toBe(true);
    const headers = requestInit?.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    const expectedSignature = createHmac("sha256", "webhook-secret")
      .update(`${headers["X-SupaCloud-Timestamp"]}.${requestInit?.body}`)
      .digest("hex");
    expect(requestInit?.redirect).toBe("manual");
    expect(headers["X-SupaCloud-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-SupaCloud-Key-Id"]).toBe("v2");
    expect(headers["X-SupaCloud-Replay-Of"]).toBe(originalDelivery.id);
    expect(headers["X-SupaCloud-Signature"]).toBe(`v1=${expectedSignature}`);
    expect(body).toMatchObject({
      id: originalDelivery.event_id,
      type: originalDelivery.event_type,
      api_version: "2026-06-01",
      payload: originalDelivery.payload,
    });
    expect(body.delivery_id).toBe(headers["X-SupaCloud-Delivery-Id"]);
    expect(body.delivery_id).not.toBe(originalDelivery.id);
  });

  test("records redirects as failures without following the location", async () => {
    let redirectMode: RequestRedirect | undefined;
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response("redirect", { status: 302, headers: { location: "http://127.0.0.1/private" } });
    });

    expect(await processOneWebhookDelivery(fetchImpl)).toBe(true);
    expect(redirectMode).toBe("manual");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persistedQueries.some(({ values }) => values.includes("failed"))).toBe(true);
  });

  test("redacts a quoted token before truncating the response preview", async () => {
    const token = `secret-${"x".repeat(5_000)}`;
    const responseBody = JSON.stringify({ access_token: token, safe: "visible" });
    expect(await processOneWebhookDelivery(mock(async () => new Response(responseBody)))).toBe(true);
    const deliveryInsert = persistedQueries.find(({ text }) => text.includes("INSERT INTO webhook_deliveries"));
    expect(deliveryInsert?.values).toContain("{\"access_token\":\"[REDACTED]\",\"safe\":\"visible\"}");
    expect(deliveryInsert?.values.join(" ")).not.toContain("secret-");
  });

  test("dead-letters the final failed attempt instead of scheduling another retry", async () => {
    claimedAttemptCount = 4;
    const fetchImpl = mock(async () => new Response("failed", { status: 503 })) as unknown as typeof fetch;
    expect(await processOneWebhookDelivery(fetchImpl)).toBe(true);
    expect(persistedQueries.some(({ values }) => values.includes("dead_lettered"))).toBe(true);
    expect(persistedQueries.some(({ values }) => values.includes("retry_scheduled"))).toBe(false);
  });

  test("rejects a non-UUID event id before building the SQL cast", async () => {
    await expect(webhookDeliveryService.enqueueEvent(
      "proj_1",
      { id: "not-a-uuid", type: "user.created", payload: {} },
      "event-key",
      "admin",
    )).rejects.toThrow("id must be a UUID");
  });

  test("enqueues a normalized event on the caller-owned transaction", async () => {
    const queued = await enqueueWebhookEventInTransaction(txMock as never, {
      projectRef: "proj_1",
      event: {
        id: "66666666-6666-4666-8666-666666666666",
        type: "organization.created",
        occurred_at: "2026-07-20T00:00:00.000Z",
        payload: { org_id: "org-one" },
      },
      idempotencyKey: "organization.created:org-one",
      actor: "admin-one",
    });

    expect(queued).toMatchObject({ queued: 1, duplicate: false });
    expect(sqlMock.begin).not.toHaveBeenCalled();
    const outboxInsert = persistedQueries.find(({ text }) => text.includes("INSERT INTO webhook_outbox"));
    expect(outboxInsert?.values).toContain("organization.created:org-one");
    expect(outboxInsert?.values).toContain("admin-one");
  });

  test("rejects oversized event input and a full unfinished queue", async () => {
    await expect(webhookDeliveryService.enqueueEvent(
      "proj_1",
      { type: "x".repeat(129), payload: {} },
      "event-key",
      "admin",
    )).rejects.toThrow("event type must be at most 128 bytes");
    await expect(webhookDeliveryService.enqueueEvent(
      "proj_1",
      { type: "user.created", payload: { text: "x".repeat(256 * 1_024) } },
      "event-key",
      "admin",
    )).rejects.toThrow("payload must be at most 262144 bytes");
    await expect(webhookDeliveryService.enqueueEvent(
      "proj_1",
      { type: "user.created", payload: {} },
      "x".repeat(256),
      "admin",
    )).rejects.toThrow("Idempotency-Key must be at most 255 bytes");

    unfinishedOutboxCount = 10_000;
    await expect(webhookDeliveryService.enqueueEvent(
      "proj_1",
      { type: "user.created", payload: {} },
      "event-key",
      "admin",
    )).rejects.toThrow("cannot exceed 10000 unfinished items");
  });

  test("soft-deletes definitions without deleting delivery history", async () => {
    const removed = await webhookDeliveryService.deleteWebhook("proj_1", webhookRow.id);
    expect(removed).toMatchObject({ id: webhookRow.id });
    expect(persistedQueries.some(({ text }) => /DELETE\s+FROM\s+project_webhooks/i.test(text))).toBe(false);
    expect(persistedQueries.some(({ text }) => text.includes("deleted_at = NOW()"))).toBe(true);
    expect(persistedQueries.some(({ text }) => text.includes("status = 'cancelled'"))).toBe(true);

    persistedQueries = [];
    const delivery = await webhookDeliveryService.getDelivery("proj_1", webhookRow.id, originalDelivery.id);
    expect(delivery).toMatchObject({ id: originalDelivery.id, event_id: originalDelivery.event_id });
    expect(persistedQueries.some(({ text }) => text.includes("deleted_at IS NULL"))).toBe(false);
  });

  test("queues replay from immutable event fields without old signing metadata", async () => {
    const replay = await webhookDeliveryService.replayDelivery(
      "proj_1",
      webhookRow.id,
      originalDelivery.id,
      "admin-one",
    );
    expect(replay).toMatchObject({ queued: true, original_delivery_id: originalDelivery.id });
    const replayInsert = persistedQueries.find(({ text }) => (
      text.includes("INSERT INTO webhook_outbox") && text.includes("replay_of_delivery_id")
    ));
    expect(replayInsert?.text).not.toContain("replay_request_body");
    expect(replayInsert?.text).not.toContain("replay_signature_timestamp");
    expect(replayInsert?.text).not.toContain("replay_secret_version");
    expect(replayInsert?.values).toContain(originalDelivery.event_id);
    expect(replayInsert?.values).toContain(originalDelivery.event_type);
    expect(replayInsert?.values).toContain(originalDelivery.api_version);
    expect(replayInsert?.values).toContain("admin-one");
    expect(replayInsert?.text).toContain("replay_of_delivery_id, created_by");
  });
});
