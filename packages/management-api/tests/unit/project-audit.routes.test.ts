import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const sqlCalls: string[] = [];
const insertedRows: Array<Record<string, unknown>> = [];

const sqlMock = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  sqlCalls.push(text);
  if (text.includes("INSERT INTO audit_logs")) {
    const metadata = JSON.parse(String(values[7] || "{}")) as Record<string, unknown>;
    const row = {
      id: "audit-new",
      project_ref: values[0],
      actor: values[1],
      action: values[2],
      method: values[3],
      path: values[4],
      status: values[5],
      ip_address: null,
      user_agent: "",
      request_id: values[6],
      metadata,
      created_at: new Date("2026-06-18T12:00:00.000Z"),
    };
    insertedRows.push(row);
    return Promise.resolve([row]);
  }
  if (text.includes("WHERE project_ref =") && text.includes("id =")) {
    return Promise.resolve([
      {
        id: "audit-one",
        project_ref: "proj_1",
        actor: "user-one",
        action: "webhook.create",
        method: "EVENT",
        path: "/v1/projects/proj_1/audit/events",
        status: 200,
        ip_address: null,
        user_agent: "",
        request_id: "req-one",
        metadata: {
          actor_id: "user-one",
          actor_type: "admin",
          resource_type: "webhook",
          resource_id: "wh-one",
          details: { url: "https://example.com" },
        },
        created_at: new Date("2026-06-18T12:00:00.000Z"),
      },
    ]);
  }
  if (text.includes("FROM audit_logs")) {
    return Promise.resolve([
      {
        id: "audit-one",
        project_ref: "proj_1",
        actor: "user-one",
        action: "webhook.create",
        method: "EVENT",
        path: "/v1/projects/proj_1/audit/events",
        status: 200,
        ip_address: null,
        user_agent: "",
        request_id: "req-one",
        metadata: {
          actor_id: "user-one",
          actor_type: "admin",
          resource_type: "webhook",
          resource_id: "wh-one",
          details: { url: "https://example.com" },
        },
        created_at: new Date("2026-06-18T12:00:00.000Z"),
      },
    ]);
  }
  return Promise.resolve([]);
});

mock.module("../../src/db", () => ({ sql: sqlMock }));

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const authModule = await import("../../src/middleware/auth");
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);

const { projectAuditRoutes } = await import("../../src/routes/project-audit");
const app = new Elysia().use(projectAuditRoutes);

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

describe("projectAuditRoutes", () => {
  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
  });

  beforeEach(() => {
    sqlCalls.length = 0;
    insertedRows.length = 0;
    sqlMock.mockClear();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
  });

  test("queries project audit logs with SupAuth-compatible fields", async () => {
    const res = await request("/v1/projects/proj_1/audit?event_type=webhook.create&resource_type=webhook&limit=5");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: "audit-one",
      event_type: "webhook.create",
      actor_id: "user-one",
      actor_type: "admin",
      resource_type: "webhook",
      resource_id: "wh-one",
    });
    expect(sqlCalls.at(-1)).toContain("FROM audit_logs");
  });

  test("gets one audit log and records product audit events", async () => {
    const detail = await request("/v1/projects/proj_1/audit/audit-one");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: "audit-one", event_type: "webhook.create" });

    const create = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      body: JSON.stringify({
        event_type: "webhook.test",
        actor_id: "admin-one",
        actor_type: "admin",
        resource_type: "webhook",
        resource_id: "wh-one",
        details: { ok: true },
      }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({
      id: "audit-new",
      event_type: "webhook.test",
      actor_id: "admin-one",
      resource_type: "webhook",
    });
    expect(insertedRows).toHaveLength(1);
  });
});
