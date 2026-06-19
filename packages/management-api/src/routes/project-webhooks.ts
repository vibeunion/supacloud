import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { isLogDrainUrlSafeForFetch, validateLogDrainUrl } from "./log-drains";

interface ProjectWebhook {
  id: string;
  url: string;
  events: string[];
  secret: string;
  signing_key_id?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface WebhookDeliveryLog {
  id: string;
  webhook_id: string;
  event: string;
  status: "delivered" | "failed";
  status_code?: number;
  error?: string;
  created_at: string;
}

const MAX_WEBHOOKS_PER_PROJECT = 50;
const MAX_DELIVERY_LOGS_PER_PROJECT = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readWebhooks(configValue: unknown): ProjectWebhook[] {
  const config = normalizeProjectConfig(configValue);
  const raw = config.webhooks;
  if (!Array.isArray(raw)) return [];

  return raw.filter((item): item is ProjectWebhook => {
    if (!isRecord(item)) return false;
    return typeof item.id === "string"
      && typeof item.url === "string"
      && Array.isArray(item.events)
      && item.events.every((event) => typeof event === "string")
      && typeof item.secret === "string"
      && typeof item.enabled === "boolean"
      && typeof item.created_at === "string"
      && typeof item.updated_at === "string";
  });
}

function readDeliveryLogs(configValue: unknown): WebhookDeliveryLog[] {
  const config = normalizeProjectConfig(configValue);
  const raw = config.webhook_delivery_logs;
  if (!Array.isArray(raw)) return [];

  return raw.filter((item): item is WebhookDeliveryLog => {
    if (!isRecord(item)) return false;
    return typeof item.id === "string"
      && typeof item.webhook_id === "string"
      && typeof item.event === "string"
      && (item.status === "delivered" || item.status === "failed")
      && typeof item.created_at === "string";
  });
}

function publicWebhook(webhook: ProjectWebhook) {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    signing_key_id: webhook.signing_key_id,
    enabled: webhook.enabled,
    has_secret: !!webhook.secret,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
  };
}

function findWebhook(webhooks: ProjectWebhook[], webhookId: string): ProjectWebhook | null {
  return webhooks.find((webhook) => webhook.id === webhookId) || null;
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function saveWebhookState(
  ref: string,
  projectConfig: unknown,
  webhooks: ProjectWebhook[],
  logs: WebhookDeliveryLog[],
) {
  const updated = await projectRepository.updateConfig(
    ref,
    mergeProjectConfig(projectConfig, {
      webhooks,
      webhook_delivery_logs: logs.slice(0, MAX_DELIVERY_LOGS_PER_PROJECT),
    }),
  );
  if (!updated) return null;
  return updated;
}

async function deliverWebhook(
  ref: string,
  webhook: ProjectWebhook,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number; error?: string; log: WebhookDeliveryLog }> {
  const body = JSON.stringify({
    type: event,
    payload,
    timestamp: nowIso(),
    webhook_id: webhook.id,
    project_ref: ref,
  });
  const createdAt = nowIso();

  try {
    if (!(await isLogDrainUrlSafeForFetch(webhook.url))) {
      const log: WebhookDeliveryLog = {
        id: crypto.randomUUID(),
        webhook_id: webhook.id,
        event,
        status: "failed",
        error: "webhook url is not allowed",
        created_at: createdAt,
      };
      return { ok: false, error: log.error, log };
    }

    const signature = await signPayload(webhook.secret, body);
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SupaCloud-Webhook-Id": webhook.id,
        "X-SupaCloud-Event": event,
        "X-SupaCloud-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const log: WebhookDeliveryLog = {
      id: crypto.randomUUID(),
      webhook_id: webhook.id,
      event,
      status: response.ok ? "delivered" : "failed",
      status_code: response.status,
      created_at: createdAt,
    };
    return { ok: response.ok, status: response.status, log };
  } catch (error) {
    const log: WebhookDeliveryLog = {
      id: crypto.randomUUID(),
      webhook_id: webhook.id,
      event,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      created_at: createdAt,
    };
    return { ok: false, error: log.error, log };
  }
}

function eventMatches(webhook: ProjectWebhook, event: string): boolean {
  return webhook.enabled && (webhook.events.includes("*") || webhook.events.includes(event));
}

function normalizeEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((event) => String(event).trim()).filter(Boolean);
}

export const projectWebhookRoutes = new Elysia({ prefix: "/v1/projects/:ref/webhooks" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });

    const items = readWebhooks(project.config).map(publicWebhook);
    return { items, total: items.length };
  }, {
    detail: { tags: ["webhooks"], summary: "List project webhooks" },
  })
  .post("", async ({ params, body }) => {
    const input = body as { url: string; events: string[]; enabled?: boolean; signing_key_id?: string };
    const urlResult = validateLogDrainUrl(input.url || "");
    if (!urlResult.ok) return status(400, { message: urlResult.error, code: "400" });

    const events = normalizeEvents(input.events);
    if (events.length === 0) return status(400, { message: "events must not be empty", code: "400" });

    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });

    const existing = readWebhooks(project.config);
    if (existing.length >= MAX_WEBHOOKS_PER_PROJECT) {
      return status(400, { message: `A project can have at most ${MAX_WEBHOOKS_PER_PROJECT} webhooks`, code: "400" });
    }

    const timestamp = nowIso();
    const webhook: ProjectWebhook = {
      id: crypto.randomUUID(),
      url: urlResult.url,
      events,
      secret: randomSecret(),
      signing_key_id: input.signing_key_id,
      enabled: input.enabled ?? true,
      created_at: timestamp,
      updated_at: timestamp,
    };

    const updated = await saveWebhookState(params.ref, project.config, [...existing, webhook], readDeliveryLogs(project.config));
    if (!updated) return status(404, { message: "Project not found", code: "404" });

    return { ...publicWebhook(webhook), secret: webhook.secret };
  }, {
    body: t.Object({
      url: t.String(),
      events: t.Array(t.String()),
      enabled: t.Optional(t.Boolean()),
      signing_key_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Create a project webhook" },
  })
  .post("/events", async ({ params, body }) => {
    const input = body as { event?: string; type?: string; payload?: Record<string, unknown> };
    const event = String(input.event || input.type || "").trim();
    if (!event) return status(400, { message: "event or type is required", code: "400" });

    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });

    const webhooks = readWebhooks(project.config);
    const targets = webhooks.filter((webhook) => eventMatches(webhook, event));
    const results = await Promise.all(targets.map((webhook) =>
      deliverWebhook(params.ref, webhook, event, input.payload || {}),
    ));
    const logs = [...results.map((result) => result.log), ...readDeliveryLogs(project.config)];
    await saveWebhookState(params.ref, project.config, webhooks, logs);
    return {
      queued: true,
      delivered: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      total: results.length,
    };
  }, {
    body: t.Object({
      event: t.Optional(t.String()),
      type: t.Optional(t.String()),
      payload: t.Optional(t.Record(t.String(), t.Unknown())),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Enqueue a project webhook event" },
  })
  .get("/:webhookId/logs", async ({ params, query }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const limit = Math.min(Math.max(Number(query.limit || 50), 1), 100);
    const items = readDeliveryLogs(project.config)
      .filter((log) => log.webhook_id === params.webhookId)
      .slice(0, limit);
    return { items, total: items.length };
  }, {
    query: t.Object({ limit: t.Optional(t.String()) }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "List project webhook delivery logs" },
  })
  .post("/:webhookId/rotate-secret", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhooks = readWebhooks(project.config);
    const webhook = findWebhook(webhooks, params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });

    const nextSecret = randomSecret();
    const updatedWebhook = { ...webhook, secret: nextSecret, updated_at: nowIso() };
    const updatedWebhooks = webhooks.map((item) => item.id === webhook.id ? updatedWebhook : item);
    const updated = await saveWebhookState(params.ref, project.config, updatedWebhooks, readDeliveryLogs(project.config));
    if (!updated) return status(404, { message: "Project not found", code: "404" });

    return { ...publicWebhook(updatedWebhook), secret: nextSecret };
  }, {
    detail: { tags: ["webhooks"], summary: "Rotate project webhook secret" },
  })
  .post("/:webhookId/test", async ({ params, body }) => {
    const input = body as { event?: string; payload?: Record<string, unknown> };
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhooks = readWebhooks(project.config);
    const webhook = findWebhook(webhooks, params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });

    const result = await deliverWebhook(
      params.ref,
      webhook,
      input.event || "webhook.test",
      input.payload || {},
    );
    await saveWebhookState(params.ref, project.config, webhooks, [result.log, ...readDeliveryLogs(project.config)]);
    return { ok: result.ok, status: result.status, error: result.error };
  }, {
    body: t.Object({
      event: t.Optional(t.String()),
      payload: t.Optional(t.Record(t.String(), t.Unknown())),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Send a project webhook test event" },
  })
  .post("/:webhookId/replay", async ({ params, body }) => {
    const input = body as { event: string; payload?: Record<string, unknown> };
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhooks = readWebhooks(project.config);
    const webhook = findWebhook(webhooks, params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });

    const result = await deliverWebhook(params.ref, webhook, input.event, input.payload || {});
    await saveWebhookState(params.ref, project.config, webhooks, [result.log, ...readDeliveryLogs(project.config)]);
    return { ok: result.ok, status: result.status, error: result.error };
  }, {
    body: t.Object({
      event: t.String(),
      payload: t.Optional(t.Record(t.String(), t.Unknown())),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Replay a project webhook event" },
  })
  .get("/:webhookId", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhook = findWebhook(readWebhooks(project.config), params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });
    return publicWebhook(webhook);
  }, {
    detail: { tags: ["webhooks"], summary: "Get a project webhook" },
  })
  .put("/:webhookId", async ({ params, body }) => {
    const input = body as { url?: string; events?: string[]; enabled?: boolean; signing_key_id?: string };
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhooks = readWebhooks(project.config);
    const webhook = findWebhook(webhooks, params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });

    let nextUrl = webhook.url;
    if (input.url !== undefined) {
      const urlResult = validateLogDrainUrl(input.url);
      if (!urlResult.ok) return status(400, { message: urlResult.error, code: "400" });
      nextUrl = urlResult.url;
    }
    const nextEvents = input.events !== undefined ? normalizeEvents(input.events) : webhook.events;
    if (nextEvents.length === 0) return status(400, { message: "events must not be empty", code: "400" });

    const updatedWebhook: ProjectWebhook = {
      ...webhook,
      url: nextUrl,
      events: nextEvents,
      enabled: input.enabled ?? webhook.enabled,
      signing_key_id: input.signing_key_id ?? webhook.signing_key_id,
      updated_at: nowIso(),
    };
    const updatedWebhooks = webhooks.map((item) => item.id === webhook.id ? updatedWebhook : item);
    const updated = await saveWebhookState(params.ref, project.config, updatedWebhooks, readDeliveryLogs(project.config));
    if (!updated) return status(404, { message: "Project not found", code: "404" });
    return publicWebhook(updatedWebhook);
  }, {
    body: t.Object({
      url: t.Optional(t.String()),
      events: t.Optional(t.Array(t.String())),
      enabled: t.Optional(t.Boolean()),
      signing_key_id: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Update a project webhook" },
  })
  .delete("/:webhookId", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { message: "Project not found", code: "404" });
    const webhooks = readWebhooks(project.config);
    const webhook = findWebhook(webhooks, params.webhookId);
    if (!webhook) return status(404, { message: "Webhook not found", code: "404" });
    const logs = readDeliveryLogs(project.config).filter((log) => log.webhook_id !== webhook.id);
    const updated = await saveWebhookState(params.ref, project.config, webhooks.filter((item) => item.id !== webhook.id), logs);
    if (!updated) return status(404, { message: "Project not found", code: "404" });
    return { deleted: true, webhook_id: webhook.id };
  }, {
    detail: { tags: ["webhooks"], summary: "Delete a project webhook" },
  });
