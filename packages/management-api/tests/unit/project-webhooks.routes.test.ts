import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/utils/errors";

const authModule = await import("../../src/middleware/auth");
const collaboratorModule = await import("../../src/services/project-collaborator.service");
const serviceModule = await import("../../src/services/webhook-delivery.service");

const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const authContext = spyOn(authModule, "getTransportAuthContextForDelegatedProof").mockResolvedValue({
  role: "admin",
  source: "bearer",
  principalId: "admin-one",
});
const capability = spyOn(collaboratorModule, "requireCapability").mockResolvedValue(undefined);
const service = serviceModule.webhookDeliveryService;

const spies = {
  list: spyOn(service, "listWebhooks"),
  create: spyOn(service, "createWebhook"),
  enqueue: spyOn(service, "enqueueEvent"),
  deliveries: spyOn(service, "listDeliveries"),
  detail: spyOn(service, "getDelivery"),
  replay: spyOn(service, "replayDelivery"),
  test: spyOn(service, "enqueueTest"),
  rotate: spyOn(service, "rotateSecret"),
  get: spyOn(service, "getWebhook"),
  update: spyOn(service, "updateWebhook"),
  remove: spyOn(service, "deleteWebhook"),
};

const { projectWebhookRoutes } = await import("../../src/routes/project-webhooks");
const app = new Elysia().use(projectWebhookRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer project-token",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }));
}

describe("projectWebhookRoutes v2", () => {
  afterAll(() => {
    requireAuth.mockRestore();
    authContext.mockRestore();
    capability.mockRestore();
    Object.values(spies).forEach((entry) => entry.mockRestore());
  });

  beforeEach(() => {
    Object.values(spies).forEach((entry) => entry.mockReset());
    requireAuth.mockResolvedValue(undefined);
    authContext.mockResolvedValue({ role: "admin", source: "bearer", principalId: "admin-one" });
    capability.mockReset();
    capability.mockResolvedValue(undefined);
  });

  test("creates and lists webhooks without exposing stored secrets", async () => {
    spies.create.mockResolvedValue({
      id: "wh-one",
      url: "https://hooks.example.com/events",
      events: ["user.created"],
      has_secret: true,
      signing_key_id: "v1",
    } as never);
    spies.list.mockResolvedValue({
      items: [{ id: "wh-one", url: "https://hooks.example.com/events", has_secret: true }],
      total: 1,
    } as never);

    const create = await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/events", events: ["user.created"] }),
    });
    expect(create.status).toBe(201);
    const createBody = await create.json();
    expect(createBody).toMatchObject({ id: "wh-one", has_secret: true, signing_key_id: "v1" });
    expect(JSON.stringify(createBody)).not.toContain("whsec_");
    expect(createBody).not.toHaveProperty("secret");
    expect(spies.create).toHaveBeenCalledWith("proj_1", expect.any(Object), "admin-one");

    const list = await request("/v1/projects/proj_1/webhooks");
    expect(await list.json()).toEqual({
      items: [{ id: "wh-one", url: "https://hooks.example.com/events", has_secret: true }],
      total: 1,
    });
  });

  test("rotates webhook secrets without returning the generated value", async () => {
    spies.rotate.mockResolvedValue({
      id: "wh-one",
      has_secret: true,
      signing_key_id: "v2",
      signature_version: "v1",
    } as never);

    const response = await request("/v1/projects/proj_1/webhooks/wh-one/rotate-secret", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: "wh-one", has_secret: true, signing_key_id: "v2" });
    expect(body).not.toHaveProperty("secret");
  });

  test("fails closed when a verified mutation principal is unavailable", async () => {
    authContext.mockResolvedValueOnce({ status: 401, body: { error: "invalid token" } });
    const response = await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/events", events: ["user.created"] }),
    });
    expect(response.status).toBe(401);
    expect(spies.create).not.toHaveBeenCalled();
  });

  test("persists an idempotent event and returns 202", async () => {
    spies.enqueue.mockResolvedValue({ event_id: "11111111-1111-1111-1111-111111111111", queued: 2, duplicate: false } as never);
    const response = await request("/v1/projects/proj_1/webhooks/events", {
      method: "POST",
      headers: { "idempotency-key": "user-created:user-one:v1" },
      body: JSON.stringify({ type: "user.created", payload: { id: "user-one" } }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ queued: 2, duplicate: false });
    expect(spies.enqueue).toHaveBeenCalledWith(
      "proj_1",
      expect.objectContaining({ type: "user.created" }),
      "user-created:user-one:v1",
      "admin-one",
    );
  });

  test("lists delivery details and replays only by immutable delivery id", async () => {
    spies.deliveries.mockResolvedValue({
      items: [{ id: "delivery-one", status: "failed", event_type: "user.created" }],
      total: 1,
      next_cursor: null,
    } as never);
    spies.detail.mockResolvedValue({ id: "delivery-one", payload: { id: "user-one" } } as never);
    spies.replay.mockResolvedValue({ queued: true, outbox_id: "outbox-two", original_delivery_id: "delivery-one" } as never);

    const list = await request("/v1/projects/proj_1/webhooks/wh-one/deliveries?limit=20");
    expect(await list.json()).toMatchObject({ total: 1, items: [{ id: "delivery-one" }] });

    const detail = await request("/v1/projects/proj_1/webhooks/wh-one/deliveries/delivery-one");
    expect(await detail.json()).toMatchObject({ id: "delivery-one" });

    const replay = await request("/v1/projects/proj_1/webhooks/wh-one/deliveries/delivery-one/replay", { method: "POST" });
    expect(replay.status).toBe(202);
    expect(spies.replay).toHaveBeenCalledWith("proj_1", "wh-one", "delivery-one", "admin-one");

    const rejectedLegacy = await request("/v1/projects/proj_1/webhooks/wh-one/replay", {
      method: "POST",
      body: JSON.stringify({ event: "user.created", payload: { changed: true } }),
    });
    expect(rejectedLegacy.status).toBe(400);
    expect(spies.replay).toHaveBeenCalledTimes(1);
  });

  test("returns explicit service conflicts without converting them to an empty result", async () => {
    spies.replay.mockRejectedValueOnce(new ConflictError(
      "Project webhook outbox cannot exceed 10000 unfinished items",
    ));
    const response = await request(
      "/v1/projects/proj_1/webhooks/wh-one/deliveries/delivery-one/replay",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONFLICT" });
  });

  test("keeps missing resources as explicit 404 errors", async () => {
    spies.get.mockRejectedValueOnce(new NotFoundError("Webhook", "wh-missing"));
    const response = await request("/v1/projects/proj_1/webhooks/wh-missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  test("queues a server-generated test without accepting caller payload", async () => {
    spies.test.mockResolvedValue({ queued: true, outbox_id: "outbox-test" } as never);
    const accepted = await request("/v1/projects/proj_1/webhooks/wh-one/test", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(accepted.status).toBe(202);

    const rejected = await request("/v1/projects/proj_1/webhooks/wh-one/test", {
      method: "POST",
      body: JSON.stringify({ payload: { token: "must-not-pass" } }),
    });
    expect(rejected.status).toBe(400);
    expect(spies.test).toHaveBeenCalledTimes(1);
  });

  test("enforces read, manage, and replay capabilities", async () => {
    spies.list.mockResolvedValue({ items: [], total: 0 } as never);
    await request("/v1/projects/proj_1/webhooks");
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "webhooks.read");

    spies.create.mockResolvedValue({ id: "wh-one" } as never);
    await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/events", events: ["user.created"] }),
    });
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "webhooks.manage");

    spies.replay.mockResolvedValue({ queued: true } as never);
    await request("/v1/projects/proj_1/webhooks/wh-one/deliveries/delivery-one/replay", { method: "POST" });
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "webhooks.replay");

    capability.mockRejectedValueOnce(new ForbiddenError("Missing collaborator capability: webhooks.read"));
    const denied = await request("/v1/projects/proj_1/webhooks");
    expect(denied.status).toBe(403);
  });
});
