import { createHmac, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { sql } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { isLogDrainUrlSafeForFetch, validateLogDrainUrl } from "../routes/log-drains";
import { redactAuditValue } from "./audit.service";
import { safeOutboundFetch } from "../utils/outbound-http";
import {
  readManagedControlSecret,
  removeManagedControlSecret,
  storeManagedControlSecret,
} from "./project-control-secrets.service";
import {
  WEBHOOK_SIGNING_SECRET_PREFIX,
  webhookSigningSecretName,
} from "../utils/webhook-secret";

const MAX_WEBHOOKS_PER_PROJECT = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const RESPONSE_PREVIEW_LIMIT = 4_096;
const SIGNATURE_API_VERSION = "2026-07-01";
const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200];
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_EVENT_TYPES_PER_WEBHOOK = 100;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const MAX_API_VERSION_BYTES = 20;
const MAX_PAYLOAD_BYTES = 256 * 1_024;
const MAX_UNFINISHED_OUTBOX_ITEMS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type WebhookRow = Record<string, unknown> & {
  id: string;
  project_ref: string;
  url: string;
  events: string[];
  secret_encrypted?: string | null;
  previous_secret_encrypted?: string | null;
  secret_version: number;
  enabled: boolean;
  api_version: string;
  has_secret?: boolean;
  deleted_at?: Date | string | null;
};

type WebhookEventInput = {
  id?: string;
  type: string;
  occurred_at?: string;
  api_version?: string;
  payload?: Record<string, unknown>;
};

type TransactionalWebhookEventInput = {
  projectRef: string;
  event: WebhookEventInput;
  idempotencyKey: string;
  actor: string;
};

type NormalizedWebhookEvent = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  apiVersion: string;
  payloadJson: string;
  idempotencyKey: string;
};

type NewWebhook = {
  id: string;
  projectRef: string;
  url: string;
  events: string[];
  enabled: boolean;
  actor: string;
  secret: string;
};

function randomSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function normalizedEventType(rawEventType: unknown): string {
  const eventType = String(rawEventType).trim();
  if (!eventType) throw new ValidationError("event type must not be empty");
  if (Buffer.byteLength(eventType) > MAX_EVENT_TYPE_BYTES || !EVENT_TYPE_PATTERN.test(eventType)) {
    throw new ValidationError(`event type must be at most ${MAX_EVENT_TYPE_BYTES} bytes and use letters, numbers, dot, underscore, colon or hyphen`);
  }
  return eventType;
}

function normalizedWebhookEvent(rawEventType: unknown): string {
  const eventType = String(rawEventType).trim();
  return eventType === "*" ? eventType : normalizedEventType(eventType);
}

function normalizeEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  if (events.length > MAX_EVENT_TYPES_PER_WEBHOOK) {
    throw new ValidationError(`events must contain at most ${MAX_EVENT_TYPES_PER_WEBHOOK} entries`);
  }
  return [...new Set(events.map(normalizedWebhookEvent))];
}

function assertUuid(identifier: string, field: string): void {
  if (Buffer.byteLength(identifier) > 36 || !UUID_PATTERN.test(identifier)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
}

function normalizedIdempotencyKey(rawKey: string): string {
  const key = rawKey.trim();
  if (!key) throw new ValidationError("Idempotency-Key is required");
  if (Buffer.byteLength(key) > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new ValidationError(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`);
  }
  return key;
}

function normalizedApiVersion(rawVersion: string | undefined): string {
  const apiVersion = rawVersion?.trim() || SIGNATURE_API_VERSION;
  if (Buffer.byteLength(apiVersion) > MAX_API_VERSION_BYTES || !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new ValidationError("api_version must use YYYY-MM-DD");
  }
  return apiVersion;
}

function serializedPayload(payload: Record<string, unknown> | undefined): string {
  const inputJson = JSON.stringify(payload || {});
  if (Buffer.byteLength(inputJson) > MAX_PAYLOAD_BYTES) {
    throw new ValidationError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return JSON.stringify(redactAuditValue(payload || {}));
}

function publicWebhook(row: WebhookRow) {
  const {
    secret_encrypted: _secret,
    previous_secret_encrypted: _previous,
    legacy_id: _legacy,
    deleted_at: _deletedAt,
    ...webhook
  } = row;
  return {
    ...webhook,
    has_secret: row.has_secret === true,
    signing_key_id: `v${row.secret_version}`,
    signature_version: "v1",
  };
}

async function projectOrThrow(ref: string) {
  const [project] = await sql`SELECT ref FROM projects WHERE ref = ${ref} AND deleted_at IS NULL`;
  if (!project) throw new NotFoundError("Project", ref);
}

async function assertWebhookCapacity(database: SQL, projectRef: string): Promise<void> {
  const [count] = await database`
    SELECT COUNT(*)::int AS count FROM project_webhooks
    WHERE project_ref = ${projectRef} AND deleted_at IS NULL
  `;
  if (Number(count?.count || 0) >= MAX_WEBHOOKS_PER_PROJECT) {
    throw new ConflictError(`A project can have at most ${MAX_WEBHOOKS_PER_PROJECT} webhooks`);
  }
}

async function insertWebhookMetadata(database: SQL, input: NewWebhook): Promise<WebhookRow> {
  const [webhookMetadata] = await database`
    INSERT INTO project_webhooks (
      id, project_ref, url, events, enabled, api_version, created_by
    ) VALUES (
      ${input.id}, ${input.projectRef}, ${input.url}, ${input.events},
      ${input.enabled}, ${SIGNATURE_API_VERSION}, ${input.actor}
    ) RETURNING *
  ` as WebhookRow[];
  return webhookMetadata;
}

async function persistNewWebhook(database: SQL, input: NewWebhook): Promise<WebhookRow> {
  await database`SELECT pg_advisory_xact_lock(hashtext(${`project-webhooks:${input.projectRef}`}))`;
  await assertWebhookCapacity(database, input.projectRef);
  const webhookMetadata = await insertWebhookMetadata(database, input);
  await storeManagedControlSecret(database, {
    projectRef: input.projectRef,
    scope: "webhook",
    name: webhookSigningSecretName(input.id),
    secretValue: input.secret,
  });
  return { ...webhookMetadata, has_secret: true };
}

async function activeWebhook(database: SQL, ref: string, webhookId: string): Promise<WebhookRow> {
  assertUuid(webhookId, "webhook_id");
  const [row] = await database`
    SELECT * FROM project_webhooks
    WHERE project_ref = ${ref} AND id = ${webhookId} AND deleted_at IS NULL
  ` as WebhookRow[];
  if (!row) throw new NotFoundError("Webhook", webhookId);
  return row;
}

async function storedWebhookOrThrow(ref: string, webhookId: string): Promise<WebhookRow> {
  assertUuid(webhookId, "webhook_id");
  const [webhookRow] = await sql`
    SELECT * FROM project_webhooks
    WHERE project_ref = ${ref} AND id = ${webhookId}
  ` as WebhookRow[];
  if (!webhookRow) throw new NotFoundError("Webhook", webhookId);
  return webhookRow;
}

async function activePublicWebhook(ref: string, webhookId: string): Promise<ReturnType<typeof publicWebhook>> {
  assertUuid(webhookId, "webhook_id");
  const [webhookRow] = await sql`
    SELECT w.*, (managed.name IS NOT NULL) AS has_secret
    FROM project_webhooks w
    LEFT JOIN project_control_secrets managed
      ON managed.project_ref = w.project_ref
     AND managed.scope = 'webhook'
     AND managed.name = ${WEBHOOK_SIGNING_SECRET_PREFIX} || w.id::text
    WHERE w.project_ref = ${ref} AND w.id = ${webhookId} AND w.deleted_at IS NULL
  ` as WebhookRow[];
  if (!webhookRow) throw new NotFoundError("Webhook", webhookId);
  return publicWebhook(webhookRow);
}

function decodeCursor(cursorValue: string | undefined): { createdAt: string; id: string } | null {
  if (!cursorValue) return null;
  const decoded = Buffer.from(cursorValue, "base64url").toString("utf8");
  const split = decoded.lastIndexOf("|");
  if (split <= 0) return null;
  const createdAt = decoded.slice(0, split);
  const id = decoded.slice(split + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !id) return null;
  return { createdAt, id };
}

function encodeCursor(row: Record<string, unknown>): string {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : String(row.created_at);
  return Buffer.from(`${createdAt}|${String(row.id)}`).toString("base64url");
}

function safeResponsePreview(text: string): string {
  try {
    const parsedResponse = JSON.parse(text);
    return JSON.stringify(redactAuditValue(parsedResponse)).slice(0, RESPONSE_PREVIEW_LIMIT);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return String(redactAuditValue(text)).slice(0, RESPONSE_PREVIEW_LIMIT);
  }
}

async function assertOutboxCapacity(database: SQL, ref: string, additions: number): Promise<void> {
  const [unfinished] = await database`
    SELECT COUNT(*)::int AS count FROM webhook_outbox
    WHERE project_ref = ${ref} AND status IN ('pending', 'delivering', 'retry_scheduled')
  `;
  if (Number(unfinished?.count || 0) + additions > MAX_UNFINISHED_OUTBOX_ITEMS) {
    throw new ConflictError(`Project webhook outbox cannot exceed ${MAX_UNFINISHED_OUTBOX_ITEMS} unfinished items`);
  }
}

function normalizeWebhookEvent(input: WebhookEventInput, idempotencyKey: string): NormalizedWebhookEvent {
  if (input.id !== undefined) assertUuid(input.id, "id");
  const occurredAt = input.occurred_at || new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) throw new ValidationError("occurred_at must be an ISO timestamp");
  return {
    eventId: input.id || crypto.randomUUID(),
    eventType: normalizedEventType(input.type),
    occurredAt,
    apiVersion: normalizedApiVersion(input.api_version),
    payloadJson: serializedPayload(input.payload),
    idempotencyKey: normalizedIdempotencyKey(idempotencyKey),
  };
}

async function newSubscriptionCount(
  database: SQL,
  ref: string,
  event: NormalizedWebhookEvent,
): Promise<number> {
  const [row] = await database`
    SELECT COUNT(*)::int AS count FROM project_webhooks w
    WHERE w.project_ref = ${ref} AND w.enabled = true AND w.deleted_at IS NULL
      AND (${event.eventType} = ANY(w.events) OR '*' = ANY(w.events))
      AND NOT EXISTS (
        SELECT 1 FROM webhook_outbox existing
        WHERE existing.project_ref = ${ref} AND existing.webhook_id = w.id
          AND existing.idempotency_key = ${event.idempotencyKey}
      )
  `;
  return Number(row?.count || 0);
}

async function insertEventSubscriptions(
  database: SQL,
  ref: string,
  event: NormalizedWebhookEvent,
  actor: string,
) {
  return database`
    INSERT INTO webhook_outbox (
      project_ref, webhook_id, event_id, event_type, payload, occurred_at, api_version,
      idempotency_key, max_attempts, created_by
    )
    SELECT ${ref}, w.id, ${event.eventId}::uuid, ${event.eventType}, ${event.payloadJson}::jsonb,
           ${event.occurredAt}::timestamptz, ${event.apiVersion},
           ${event.idempotencyKey}, ${DEFAULT_MAX_ATTEMPTS}, ${actor}
    FROM project_webhooks w
    WHERE w.project_ref = ${ref} AND w.enabled = true AND w.deleted_at IS NULL
      AND (${event.eventType} = ANY(w.events) OR '*' = ANY(w.events))
    ON CONFLICT (project_ref, webhook_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id, webhook_id, event_id
  `;
}

async function existingEventId(database: SQL, ref: string, idempotencyKey: string) {
  const [row] = await database`
    SELECT event_id FROM webhook_outbox
    WHERE project_ref = ${ref} AND idempotency_key = ${idempotencyKey}
    ORDER BY created_at ASC LIMIT 1
  `;
  return row?.event_id;
}

async function enqueueNormalizedEvent(
  database: SQL,
  ref: string,
  event: NormalizedWebhookEvent,
  actor: string,
) {
  await database`SELECT pg_advisory_xact_lock(hashtext(${`webhook-outbox:${ref}`}))`;
  await assertOutboxCapacity(database, ref, await newSubscriptionCount(database, ref, event));
  const rows = await insertEventSubscriptions(database, ref, event, actor);
  await assertOutboxCapacity(database, ref, 0);
  const duplicateEventId = rows.length === 0
    ? await existingEventId(database, ref, event.idempotencyKey)
    : null;
  return {
    event_id: String(rows[0]?.event_id || duplicateEventId || event.eventId),
    queued: rows.length,
    duplicate: rows.length === 0 && Boolean(duplicateEventId),
  };
}

export async function enqueueWebhookEventInTransaction(
  database: SQL,
  input: TransactionalWebhookEventInput,
) {
  const event = normalizeWebhookEvent(input.event, input.idempotencyKey);
  return enqueueNormalizedEvent(database, input.projectRef, event, input.actor);
}

export const webhookDeliveryService = {
  async listWebhooks(ref: string) {
    await projectOrThrow(ref);
    const rows = await sql`
      SELECT w.*, (managed.name IS NOT NULL) AS has_secret
      FROM project_webhooks w
      LEFT JOIN project_control_secrets managed
        ON managed.project_ref = w.project_ref
       AND managed.scope = 'webhook'
       AND managed.name = ${WEBHOOK_SIGNING_SECRET_PREFIX} || w.id::text
      WHERE w.project_ref = ${ref} AND w.deleted_at IS NULL
      ORDER BY w.created_at ASC
    ` as WebhookRow[];
    return { items: rows.map(publicWebhook), total: rows.length };
  },

  async getWebhook(ref: string, webhookId: string) {
    return activePublicWebhook(ref, webhookId);
  },

  async createWebhook(ref: string, input: { url: string; events: string[]; enabled?: boolean }, actor: string) {
    await projectOrThrow(ref);
    const validated = validateLogDrainUrl(input.url || "");
    if (!validated.ok) throw new ValidationError(validated.error);
    const events = normalizeEvents(input.events);
    if (events.length === 0) throw new ValidationError("events must not be empty");
    const newWebhook: NewWebhook = {
      id: crypto.randomUUID(),
      projectRef: ref,
      url: validated.url,
      events,
      enabled: input.enabled ?? true,
      actor,
      secret: randomSecret(),
    };
    const webhookRow = await sql.begin((transaction) => persistNewWebhook(transaction, newWebhook));
    return publicWebhook(webhookRow);
  },

  async updateWebhook(ref: string, webhookId: string, input: { url?: string; events?: string[]; enabled?: boolean }) {
    const current = await activeWebhook(sql, ref, webhookId);
    let url = current.url;
    if (input.url !== undefined) {
      const validated = validateLogDrainUrl(input.url);
      if (!validated.ok) throw new ValidationError(validated.error);
      url = validated.url;
    }
    const events = input.events === undefined ? current.events : normalizeEvents(input.events);
    if (events.length === 0) throw new ValidationError("events must not be empty");
    await sql`
      UPDATE project_webhooks SET
        url = ${url}, events = ${events}, enabled = ${input.enabled ?? current.enabled}, updated_at = NOW()
      WHERE project_ref = ${ref} AND id = ${webhookId}
    `;
    return activePublicWebhook(ref, webhookId);
  },

  async deleteWebhook(ref: string, webhookId: string) {
    assertUuid(webhookId, "webhook_id");
    return sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT id FROM project_webhooks
        WHERE project_ref = ${ref} AND id = ${webhookId} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!current) throw new NotFoundError("Webhook", webhookId);
      const [deletedWebhook] = await tx`
        UPDATE project_webhooks
        SET enabled = false, deleted_at = NOW(), updated_at = NOW()
        WHERE project_ref = ${ref} AND id = ${webhookId}
        RETURNING id, deleted_at
      `;
      await tx`
        UPDATE webhook_outbox
        SET status = 'cancelled', locked_at = NULL,
            last_error = 'Webhook was soft-deleted before delivery', updated_at = NOW()
        WHERE project_ref = ${ref} AND webhook_id = ${webhookId}
          AND status IN ('pending', 'delivering', 'retry_scheduled')
      `;
      await removeManagedControlSecret(tx, {
        projectRef: ref,
        scope: "webhook",
        name: webhookSigningSecretName(webhookId),
      });
      return deletedWebhook;
    });
  },

  async rotateSecret(ref: string, webhookId: string) {
    const secret = randomSecret();
    return sql.begin(async (tx) => {
      await activeWebhook(tx, ref, webhookId);
      await storeManagedControlSecret(tx, {
        projectRef: ref,
        scope: "webhook",
        name: webhookSigningSecretName(webhookId),
        secretValue: secret,
      });
      const [rotatedWebhook] = await tx`
        UPDATE project_webhooks SET
          secret_version = secret_version + 1,
          updated_at = NOW()
        WHERE project_ref = ${ref} AND id = ${webhookId}
        RETURNING *
      ` as WebhookRow[];
      return publicWebhook({ ...rotatedWebhook, has_secret: true });
    });
  },

  async enqueueEvent(ref: string, input: WebhookEventInput, idempotencyKey: string, actor: string) {
    await projectOrThrow(ref);
    return sql.begin((tx) => enqueueWebhookEventInTransaction(tx, {
      projectRef: ref,
      event: input,
      idempotencyKey,
      actor,
    }));
  },

  async enqueueTest(ref: string, webhookId: string, actor: string) {
    return sql.begin(async (tx) => {
      await activeWebhook(tx, ref, webhookId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`webhook-outbox:${ref}`}))`;
      await assertOutboxCapacity(tx, ref, 1);
      const [row] = await tx`
        INSERT INTO webhook_outbox (
          project_ref, webhook_id, event_type, payload, idempotency_key, max_attempts, created_by
        ) VALUES (
          ${ref}, ${webhookId}, 'webhook.test', ${JSON.stringify({ source: "supacloud", generated: true })}::jsonb,
          ${`test:${crypto.randomUUID()}`}, ${DEFAULT_MAX_ATTEMPTS}, ${actor}
        ) RETURNING id, event_id
      `;
      return { queued: true, outbox_id: row.id, event_id: row.event_id };
    });
  },

  async listDeliveries(ref: string, webhookId: string, input: {
    cursor?: string;
    limit?: number;
    status?: string;
    event?: string;
    from?: string;
    to?: string;
  }) {
    await storedWebhookOrThrow(ref, webhookId);
    const cursor = decodeCursor(input.cursor);
    if (input.cursor && !cursor) throw new ValidationError("Invalid cursor");
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit || 50)));
    const statusFilter = input.status?.trim() || null;
    const eventFilter = input.event?.trim() || null;
    const from = input.from?.trim() || null;
    const to = input.to?.trim() || null;
    const [count] = await sql`
      SELECT COUNT(*)::int AS count
      FROM webhook_deliveries d
      JOIN webhook_outbox o ON o.id = d.outbox_id
      WHERE d.project_ref = ${ref} AND d.webhook_id = ${webhookId}
        AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
        AND (${eventFilter}::text IS NULL OR o.event_type = ${eventFilter})
        AND (${from}::timestamptz IS NULL OR d.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR d.created_at <= ${to}::timestamptz)
    `;
    const rows = await sql`
      SELECT d.*, o.event_id, o.event_type, o.status AS outbox_status,
             o.replay_of_delivery_id
      FROM webhook_deliveries d
      JOIN webhook_outbox o ON o.id = d.outbox_id
      WHERE d.project_ref = ${ref} AND d.webhook_id = ${webhookId}
        AND (${statusFilter}::text IS NULL OR d.status = ${statusFilter})
        AND (${eventFilter}::text IS NULL OR o.event_type = ${eventFilter})
        AND (${from}::timestamptz IS NULL OR d.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR d.created_at <= ${to}::timestamptz)
        AND (${cursor?.createdAt || null}::timestamptz IS NULL
          OR (d.created_at, d.id) < (${cursor?.createdAt || null}::timestamptz, ${cursor?.id || null}::uuid))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items,
      total: Number(count?.count || 0),
      next_cursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
    };
  },

  async getDelivery(ref: string, webhookId: string, deliveryId: string) {
    assertUuid(webhookId, "webhook_id");
    assertUuid(deliveryId, "delivery_id");
    const [row] = await sql`
      SELECT d.*, o.event_id, o.event_type, o.payload, o.status AS outbox_status,
             o.attempt_count, o.max_attempts, o.next_attempt_at,
             o.replay_of_delivery_id, o.occurred_at, o.api_version,
             o.created_at AS event_created_at
      FROM webhook_deliveries d
      JOIN webhook_outbox o ON o.id = d.outbox_id
      WHERE d.project_ref = ${ref} AND d.webhook_id = ${webhookId} AND d.id = ${deliveryId}
    `;
    if (!row) throw new NotFoundError("Webhook delivery", deliveryId);
    return { ...row, payload: redactAuditValue(row.payload) };
  },

  async replayDelivery(ref: string, webhookId: string, deliveryId: string, actor: string) {
    assertUuid(deliveryId, "delivery_id");
    return sql.begin(async (tx) => {
      await activeWebhook(tx, ref, webhookId);
      const [delivery] = await tx`
        SELECT o.event_id, o.event_type, o.payload, o.occurred_at, o.api_version
        FROM webhook_deliveries d
        JOIN webhook_outbox o ON o.id = d.outbox_id
        WHERE d.project_ref = ${ref} AND d.webhook_id = ${webhookId} AND d.id = ${deliveryId}
      `;
      if (!delivery) throw new NotFoundError("Webhook delivery", deliveryId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`webhook-outbox:${ref}`}))`;
      await assertOutboxCapacity(tx, ref, 1);
      const [row] = await tx`
        INSERT INTO webhook_outbox (
          project_ref, webhook_id, event_id, event_type, payload, occurred_at, api_version,
          idempotency_key, max_attempts, replay_of_delivery_id, created_by
        ) VALUES (
          ${ref}, ${webhookId}, ${delivery.event_id}::uuid, ${String(delivery.event_type)},
          ${JSON.stringify(delivery.payload || {})}::jsonb, ${String(delivery.occurred_at)}::timestamptz,
          ${String(delivery.api_version || SIGNATURE_API_VERSION)},
          ${`replay:${deliveryId}:${crypto.randomUUID()}`}, ${DEFAULT_MAX_ATTEMPTS},
          ${deliveryId}::uuid, ${actor}
        ) RETURNING id, event_id, replay_of_delivery_id
      `;
      return { queued: true, outbox_id: row.id, event_id: row.event_id, original_delivery_id: deliveryId };
    });
  },
};

type ClaimedDelivery = WebhookRow & {
  outbox_id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  event_created_at: Date | string;
  occurred_at: Date | string;
  outbox_api_version: string;
  replay_of_delivery_id?: string | null;
};

type OutboundSender = (url: string, init?: RequestInit) => Promise<Response>;

async function claimNextDelivery(): Promise<ClaimedDelivery | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT o.id AS outbox_id, o.event_id, o.event_type, o.payload,
             o.attempt_count, o.max_attempts, o.created_at AS event_created_at,
             o.occurred_at, o.api_version AS outbox_api_version,
             o.replay_of_delivery_id,
             w.*
      FROM webhook_outbox o
      JOIN project_webhooks w ON w.id = o.webhook_id
      WHERE (
        (o.status IN ('pending', 'retry_scheduled') AND o.next_attempt_at <= NOW())
        OR (o.status = 'delivering' AND o.locked_at < NOW() - INTERVAL '5 minutes')
      ) AND w.deleted_at IS NULL
      ORDER BY o.next_attempt_at ASC, o.created_at ASC
      LIMIT 1
      FOR UPDATE OF o SKIP LOCKED
    ` as ClaimedDelivery[];
    if (!row) return null;
    await tx`
      UPDATE webhook_outbox
      SET status = 'delivering', locked_at = NOW(), attempt_count = attempt_count + 1, updated_at = NOW()
      WHERE id = ${row.outbox_id}
    `;
    return { ...row, attempt_count: Number(row.attempt_count) + 1 };
  });
}

function signature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function isoTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
}

function normalDeliveryBody(claimed: ClaimedDelivery, deliveryId: string): string {
  return JSON.stringify({
    id: claimed.event_id,
    type: claimed.event_type,
    occurred_at: isoTimestamp(claimed.occurred_at),
    api_version: claimed.outbox_api_version,
    delivery_id: deliveryId,
    payload: claimed.payload,
  });
}

type DeliveryRequest = {
  body: string;
  timestamp: string;
  apiVersion: string;
  secretVersion: number;
};

async function signingSecret(claimed: ClaimedDelivery): Promise<string> {
  const secret = await readManagedControlSecret(sql, {
    projectRef: claimed.project_ref,
    scope: "webhook",
    name: webhookSigningSecretName(claimed.id),
  });
  if (!secret) throw new Error(`Managed webhook signing secret is unavailable for ${claimed.id}`);
  return secret;
}

function deliveryRequest(claimed: ClaimedDelivery, deliveryId: string): DeliveryRequest {
  return {
    body: normalDeliveryBody(claimed, deliveryId),
    timestamp: String(Math.floor(Date.now() / 1000)),
    apiVersion: claimed.outbox_api_version,
    secretVersion: claimed.secret_version,
  };
}

type DeliveryAttempt = DeliveryRequest & {
  ok: boolean;
  statusCode: number | null;
  errorMessage: string | null;
  responsePreview: string | null;
};

function failedAttempt(request: DeliveryRequest, error: unknown): DeliveryAttempt {
  return {
    ...request,
    ok: false,
    statusCode: null,
    errorMessage: error instanceof Error ? error.message : String(error),
    responsePreview: null,
  };
}

async function deliverRequest(
  claimed: ClaimedDelivery,
  deliveryId: string,
  request: DeliveryRequest,
  fetchImpl: OutboundSender,
): Promise<Response> {
  const secret = await signingSecret(claimed);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SupaCloud-Webhook/2",
    "X-SupaCloud-Delivery-Id": deliveryId,
    "X-SupaCloud-Event": claimed.event_type,
    "X-SupaCloud-Timestamp": request.timestamp,
    "X-SupaCloud-Key-Id": `v${request.secretVersion}`,
    "X-SupaCloud-Signature": signature(secret, request.timestamp, request.body),
  };
  if (claimed.replay_of_delivery_id) {
    headers["X-SupaCloud-Replay-Of"] = claimed.replay_of_delivery_id;
  }
  return fetchImpl(claimed.url, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

async function completedAttempt(request: DeliveryRequest, response: Response): Promise<DeliveryAttempt> {
  return {
    ...request,
    ok: response.ok,
    statusCode: response.status,
    errorMessage: response.ok ? null : `Webhook returned HTTP ${response.status}`,
    responsePreview: safeResponsePreview(await response.text()),
  };
}

async function sendDelivery(
  claimed: ClaimedDelivery,
  deliveryId: string,
  fetchImpl: OutboundSender,
): Promise<DeliveryAttempt> {
  const request = deliveryRequest(claimed, deliveryId);
  try {
    if (!(await isLogDrainUrlSafeForFetch(claimed.url))) throw new Error("webhook url is not allowed");
    return completedAttempt(request, await deliverRequest(claimed, deliveryId, request, fetchImpl));
  } catch (error: unknown) {
    return failedAttempt(request, error);
  }
}

function attemptStatuses(claimed: ClaimedDelivery, attempt: DeliveryAttempt) {
  const exhausted = !attempt.ok && claimed.attempt_count >= claimed.max_attempts;
  return {
    delivery: attempt.ok ? "delivered" : exhausted ? "dead_lettered" : "failed",
    outbox: attempt.ok ? "delivered" : exhausted ? "dead_lettered" : "retry_scheduled",
  } as const;
}

async function persistDeliveryAttempt(
  claimed: ClaimedDelivery,
  deliveryId: string,
  attempt: DeliveryAttempt,
): Promise<void> {
  const statuses = attemptStatuses(claimed, attempt);
  const retryDelay = RETRY_DELAYS_SECONDS[Math.min(claimed.attempt_count - 1, RETRY_DELAYS_SECONDS.length - 1)];
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO webhook_deliveries (
        id, outbox_id, project_ref, webhook_id, attempt, status, status_code,
        error, response_preview, request_bytes, signature_version, secret_version,
        request_body, signature_timestamp, request_api_version, completed_at
      ) VALUES (
        ${deliveryId}, ${claimed.outbox_id}, ${claimed.project_ref}, ${claimed.id},
        ${claimed.attempt_count}, ${statuses.delivery}, ${attempt.statusCode}, ${attempt.errorMessage},
        ${attempt.responsePreview}, ${Buffer.byteLength(attempt.body)}, 'v1', ${attempt.secretVersion},
        ${attempt.body}, ${attempt.timestamp}, ${attempt.apiVersion}, NOW()
      )
    `;
    await tx`
      UPDATE webhook_outbox SET
        status = ${statuses.outbox},
        next_attempt_at = CASE WHEN ${statuses.outbox} = 'retry_scheduled'
          THEN NOW() + (${retryDelay}::text || ' seconds')::interval
          ELSE next_attempt_at END,
        locked_at = NULL,
        last_error = ${attempt.errorMessage},
        updated_at = NOW()
      WHERE id = ${claimed.outbox_id}
    `;
  });
}

export async function processOneWebhookDelivery(fetchImpl: OutboundSender = safeOutboundFetch): Promise<boolean> {
  const claimed = await claimNextDelivery();
  if (!claimed) return false;
  const deliveryId = crypto.randomUUID();
  const attempt = await sendDelivery(claimed, deliveryId, fetchImpl);
  await persistDeliveryAttempt(claimed, deliveryId, attempt);
  return true;
}
