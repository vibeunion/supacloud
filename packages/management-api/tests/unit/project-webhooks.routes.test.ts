import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(
  updateConfig as typeof projectRepository.updateConfig,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);

const { projectWebhookRoutes } = await import("../../src/routes/project-webhooks");
const app = new Elysia().use(projectWebhookRoutes);

type TestProject = {
  ref: string;
  config: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dev-master-token",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("projectWebhookRoutes", () => {
  let storedConfig: Record<string, unknown>;
  const delivered: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];

  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    storedConfig = {};
    delivered.length = 0;
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    findByRef.mockImplementation(async () => ({ ref: "proj_1", config: storedConfig }) as TestProject as never);
    updateConfig.mockImplementation(async (_ref, nextConfig) => {
      storedConfig = nextConfig;
      return { ref: "proj_1", config: storedConfig } as TestProject as never;
    });
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      delivered.push({
        url,
        body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
      });
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
  });

  test("creates, lists, updates, rotates, and deletes project webhooks", async () => {
    const create = await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://1.1.1.1/webhook", events: ["user.created"], enabled: true }),
    });
    expect(create.status).toBe(200);
    const created = await create.json() as { id: string; secret: string; has_secret: boolean };
    expect(created.id).toBeTruthy();
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.has_secret).toBe(true);

    const list = await request("/v1/projects/proj_1/webhooks");
    expect(await list.json()).toMatchObject({
      total: 1,
      items: [{ id: created.id, url: "https://1.1.1.1/webhook", has_secret: true }],
    });

    const update = await request(`/v1/projects/proj_1/webhooks/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, events: ["*"] }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ id: created.id, enabled: false, events: ["*"] });

    const rotate = await request(`/v1/projects/proj_1/webhooks/${created.id}/rotate-secret`, { method: "POST" });
    expect(rotate.status).toBe(200);
    const rotated = await rotate.json() as { secret: string };
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);

    const remove = await request(`/v1/projects/proj_1/webhooks/${created.id}`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(await request("/v1/projects/proj_1/webhooks").then((res) => res.json())).toMatchObject({ items: [], total: 0 });
  });

  test("delivers test and event payloads and exposes delivery logs", async () => {
    const created = await (await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://1.1.1.1/webhook", events: ["user.created"], enabled: true }),
    })).json() as { id: string };
    const second = await (await request("/v1/projects/proj_1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://1.1.1.2/webhook", events: ["user.created"], enabled: true }),
    })).json() as { id: string };

    const testDelivery = await request(`/v1/projects/proj_1/webhooks/${created.id}/test`, {
      method: "POST",
      body: JSON.stringify({ event: "webhook.test", payload: { source: "unit" } }),
    });
    expect(testDelivery.status).toBe(200);
    expect(await testDelivery.json()).toMatchObject({ ok: true, status: 202 });
    expect(delivered.at(-1)?.body).toMatchObject({ type: "webhook.test", payload: { source: "unit" } });
    expect(delivered.at(-1)?.headers["X-SupaCloud-Signature"]).toMatch(/^sha256=/);

    const eventDelivery = await request("/v1/projects/proj_1/webhooks/events", {
      method: "POST",
      body: JSON.stringify({ type: "user.created", payload: { id: "user-one" } }),
    });
    expect(eventDelivery.status).toBe(200);
    expect(await eventDelivery.json()).toMatchObject({ queued: true, delivered: 2, failed: 0 });

    const logs = await request(`/v1/projects/proj_1/webhooks/${created.id}/logs?limit=5`);
    const body = await logs.json() as { items: Array<{ webhook_id: string; event: string; status: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ webhook_id: created.id, event: "user.created", status: "delivered" });

    const secondLogs = await request(`/v1/projects/proj_1/webhooks/${second.id}/logs?limit=5`);
    expect(await secondLogs.json()).toMatchObject({
      total: 1,
      items: [{ webhook_id: second.id, event: "user.created", status: "delivered" }],
    });
  });

  test("skips unsafe stored webhook URLs before fetch", async () => {
    storedConfig = {
      webhooks: [
        {
          id: "unsafe-webhook",
          url: "http://127.0.0.1/internal",
          events: ["*"],
          secret: "whsec_test",
          enabled: true,
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
        },
      ],
    };

    const res = await request("/v1/projects/proj_1/webhooks/unsafe-webhook/test", {
      method: "POST",
      body: JSON.stringify({ event: "webhook.test" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: "webhook url is not allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const logs = await request("/v1/projects/proj_1/webhooks/unsafe-webhook/logs");
    expect(await logs.json()).toMatchObject({
      total: 1,
      items: [{ webhook_id: "unsafe-webhook", event: "webhook.test", status: "failed" }],
    });
  });
});
