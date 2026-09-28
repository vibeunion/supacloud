import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { resolveTrustedPrincipal, type TrustedPrincipal } from "../services/bff-proof.service";
import {
  requireCapability,
  type CollaboratorCapability,
} from "../services/project-collaborator.service";
import { webhookDeliveryService } from "../services/webhook-delivery.service";
import { isAppError, ValidationError } from "../utils/errors";

const authorizedActors = new WeakMap<Request, TrustedPrincipal>();

function toHttpError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

function webhookCapability(request: Request): CollaboratorCapability {
  if (request.method === "GET") return "webhooks.read";
  return new URL(request.url).pathname.endsWith("/replay")
    ? "webhooks.replay"
    : "webhooks.manage";
}

async function authorizeWebhookRequest(request: Request, ref: string): Promise<void> {
  const actor = await resolveTrustedPrincipal(request, ref);
  await requireCapability(ref, actor, webhookCapability(request));
  authorizedActors.set(request, actor);
}

function actorId(request: Request): string {
  return authorizedActors.get(request)!.id;
}

export const projectWebhookRoutes = new Elysia({ prefix: "/v1/projects/:ref/webhooks" })
  .beforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    try {
      await authorizeWebhookRequest(request, params.ref);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("", {
    detail: { tags: ["webhooks"], summary: "List project webhooks" },
  }, async ({ params }) => {
    try {
      return await webhookDeliveryService.listWebhooks(params.ref);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("", {
    body: t.Object({
      url: t.String(),
      events: t.Array(t.String()),
      enabled: t.Optional(t.Boolean()),
    }, { additionalProperties: false }),
    detail: { tags: ["webhooks"], summary: "Create a durable project webhook" },
  }, async ({ params, body, request, set }) => {
    try {
      const webhook = await webhookDeliveryService.createWebhook(params.ref, body, actorId(request));
      set.status = 201;
      return webhook;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/events", {
    body: t.Object({
      id: t.Optional(t.String()),
      type: t.String(),
      occurred_at: t.Optional(t.String()),
      api_version: t.Optional(t.String()),
      payload: t.Optional(t.Record(t.String(), t.Unknown())),
      idempotency_key: t.Optional(t.String()),
    }, { additionalProperties: false }),
    detail: { tags: ["webhooks"], summary: "Persist a project webhook event in the durable outbox" },
  }, async ({ params, body, request, set }) => {
    try {
      const idempotencyKey = request.headers.get("idempotency-key") || body.idempotency_key || "";
      const result = await webhookDeliveryService.enqueueEvent(params.ref, body, idempotencyKey, actorId(request));
      set.status = 202;
      return result;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:webhookId/deliveries", {
    query: t.Object({
      cursor: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      status: t.Optional(t.String()),
      event: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "List webhook deliveries with cursor pagination" },
  }, async ({ params, query }) => {
    try {
      return await webhookDeliveryService.listDeliveries(params.ref, params.webhookId, {
        cursor: query.cursor,
        limit: Number(query.limit || 50),
        status: query.status,
        event: query.event,
        from: query.from,
        to: query.to,
      });
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:webhookId/deliveries/:deliveryId", {
    detail: { tags: ["webhooks"], summary: "Get one webhook delivery attempt" },
  }, async ({ params }) => {
    try {
      return await webhookDeliveryService.getDelivery(params.ref, params.webhookId, params.deliveryId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:webhookId/deliveries/:deliveryId/replay", {
    detail: { tags: ["webhooks"], summary: "Replay an immutable webhook delivery" },
  }, async ({ params, request, set }) => {
    try {
      const result = await webhookDeliveryService.replayDelivery(
        params.ref,
        params.webhookId,
        params.deliveryId,
        actorId(request),
      );
      set.status = 202;
      return result;
    } catch (error) {
      return toHttpError(error);
    }
  })
  // One-minor compatibility alias. It reads v2 delivery records and never
  // falls back to the old config blob.
  .get("/:webhookId/logs", {
    query: t.Object({ cursor: t.Optional(t.String()), limit: t.Optional(t.String()) }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "List webhook deliveries (deprecated logs alias)", deprecated: true },
  }, async ({ params, query }) => {
    try {
      return await webhookDeliveryService.listDeliveries(params.ref, params.webhookId, {
        cursor: query.cursor,
        limit: Number(query.limit || 50),
      });
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:webhookId/replay", {
    body: t.Object({ delivery_id: t.Optional(t.String()) }, { additionalProperties: true }),
    detail: { tags: ["webhooks"], summary: "Replay a webhook delivery (deprecated alias)", deprecated: true },
  }, async ({ params, body, request, set }) => {
    try {
      if (!body.delivery_id) throw new ValidationError("delivery_id is required; custom replay payloads are not supported");
      const result = await webhookDeliveryService.replayDelivery(
        params.ref,
        params.webhookId,
        body.delivery_id,
        actorId(request),
      );
      set.status = 202;
      return result;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:webhookId/rotate-secret", {
    detail: { tags: ["webhooks"], summary: "Rotate a webhook signing secret" },
  }, async ({ params }) => {
    try {
      return await webhookDeliveryService.rotateSecret(params.ref, params.webhookId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .post("/:webhookId/test", {
    body: t.Optional(t.Record(t.String(), t.Unknown())),
    detail: { tags: ["webhooks"], summary: "Queue a server-generated webhook test event" },
  }, async ({ params, body, request, set }) => {
    try {
      if (body && Object.keys(body).length > 0) {
        throw new ValidationError("test payload is server-generated and cannot be supplied by the caller");
      }
      const result = await webhookDeliveryService.enqueueTest(params.ref, params.webhookId, actorId(request));
      set.status = 202;
      return result;
    } catch (error) {
      return toHttpError(error);
    }
  })
  .get("/:webhookId", {
    detail: { tags: ["webhooks"], summary: "Get a project webhook" },
  }, async ({ params }) => {
    try {
      return await webhookDeliveryService.getWebhook(params.ref, params.webhookId);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .put("/:webhookId", {
    body: t.Object({
      url: t.Optional(t.String()),
      events: t.Optional(t.Array(t.String())),
      enabled: t.Optional(t.Boolean()),
    }, { additionalProperties: false }),
    detail: { tags: ["webhooks"], summary: "Update a project webhook" },
  }, async ({ params, body }) => {
    try {
      return await webhookDeliveryService.updateWebhook(params.ref, params.webhookId, body);
    } catch (error) {
      return toHttpError(error);
    }
  })
  .delete("/:webhookId", {
    detail: { tags: ["webhooks"], summary: "Delete a project webhook" },
  }, async ({ params }) => {
    try {
      await webhookDeliveryService.deleteWebhook(params.ref, params.webhookId);
      return { deleted: true, webhook_id: params.webhookId };
    } catch (error) {
      return toHttpError(error);
    }
  });
