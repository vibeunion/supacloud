import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { AuthError, ForbiddenError } from "../../src/utils/errors";

const auditRow = {
  id: "11111111-1111-1111-1111-111111111111",
  project_ref: "proj_1",
  actor: "admin-one",
  actor_type: "admin",
  action: "webhook.create",
  method: "EVENT",
  path: "/v1/projects/proj_1/audit/events",
  status: 200,
  ip_address: null,
  user_agent: "",
  request_id: "req-one",
  source: "supauth",
  metadata: { resource_type: "webhook", resource_id: "wh-one", details: { secret: "[REDACTED]" } },
  previous_hash: null,
  event_hash: "hash-one",
  chain_sequence: 1,
  created_at: new Date("2026-07-19T00:00:00.000Z"),
};

const sqlQueryMock = mock((strings: TemplateStringsArray) => {
  const text = strings.join("?");
  if (text.includes("COUNT(*)::int AS count")) return Promise.resolve([{ count: 17 }]);
  if (text.includes("FROM audit_log_checkpoints")) {
    return Promise.resolve([{ project_ref: "proj_1", last_event_id: auditRow.id, last_event_hash: "hash-one", event_count: 17 }]);
  }
  if (text.includes("FROM audit_exports")) return Promise.resolve([]);
  if (text.includes("INSERT INTO audit_exports")) {
    return Promise.resolve([{ id: "22222222-2222-2222-2222-222222222222", project_ref: "proj_1", format: "jsonl", status: "completed", row_count: 1 }]);
  }
  if (text.includes("FROM audit_logs")) return Promise.resolve([auditRow]);
  return Promise.resolve([]);
});
const sqlMock = Object.assign(sqlQueryMock, {
  begin: mock((callback: (tx: typeof sqlQueryMock) => Promise<unknown>) => callback(sqlQueryMock)),
});
mock.module("../../src/db", () => ({
  sql: sqlMock,
  getProjectDb: mock(() => sqlMock),
  resolveDbName: mock((ref: string) => Promise.resolve(ref)),
}));

const authModule = await import("../../src/middleware/auth");
const auditService = await import("../../src/services/audit.service");
const collaboratorService = await import("../../src/services/project-collaborator.service");
const bffService = await import("../../src/services/bff-proof.service");
const requireAuth = spyOn(authModule, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const principal = spyOn(authModule, "getVerifiedRequestPrincipal").mockResolvedValue({ id: "admin-one", type: "admin" });
const trustedPrincipal = spyOn(bffService, "resolveTrustedPrincipal").mockResolvedValue({
  id: "admin-one",
  type: "admin",
  requestId: "req-one",
  platformAdmin: true,
});
const append = spyOn(auditService, "appendAuditEvent").mockResolvedValue(auditRow as never);
const verifyIntegrity = spyOn(auditService, "verifyProjectAuditIntegrity").mockResolvedValue({
  status: "verified",
  consistent: true,
  reason: null,
  total_event_count: 17,
  verified_event_count: 17,
  checkpoint: { project_ref: "proj_1", last_event_id: auditRow.id, last_event_hash: "hash-one", event_count: 17 },
});
const capability = spyOn(collaboratorService, "requireCapability").mockResolvedValue(undefined);

const { projectAuditRoutes } = await import("../../src/routes/project-audit");
const app = new Elysia().use(projectAuditRoutes);
const delegationAttemptHeaders = { "x-supaoauth-actor-id": "admin-one" };

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer admin-token",
      "content-type": "application/json",
      "x-request-id": "req-one",
      ...(init.headers || {}),
    },
  }));
}

describe("projectAuditRoutes v2", () => {
  afterAll(() => {
    requireAuth.mockRestore();
    principal.mockRestore();
    trustedPrincipal.mockRestore();
    append.mockRestore();
    verifyIntegrity.mockRestore();
    capability.mockRestore();
  });

  beforeEach(() => {
    sqlMock.mockClear();
    sqlMock.begin.mockClear();
    append.mockClear();
    verifyIntegrity.mockClear();
    capability.mockClear();
    trustedPrincipal.mockClear();
    append.mockResolvedValue(auditRow as never);
    verifyIntegrity.mockResolvedValue({
      status: "verified",
      consistent: true,
      reason: null,
      total_event_count: 17,
      verified_event_count: 17,
      checkpoint: { project_ref: "proj_1", last_event_id: auditRow.id, last_event_hash: "hash-one", event_count: 17 },
    });
    requireAuth.mockResolvedValue(undefined);
    principal.mockResolvedValue({ id: "admin-one", type: "admin" });
    trustedPrincipal.mockResolvedValue({
      id: "admin-one",
      type: "admin",
      requestId: "req-one",
      platformAdmin: true,
    });
    capability.mockResolvedValue(undefined);
  });

  test("returns accurate total separately from the current page", async () => {
    const response = await request("/v1/projects/proj_1/audit?limit=5&event_type=webhook.create");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 17,
      items: [{ id: auditRow.id, actor_id: "admin-one", event_hash: "hash-one" }],
    });
  });

  test("ignores caller-supplied actor and preserves the verified request id", async () => {
    const response = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      headers: delegationAttemptHeaders,
      body: JSON.stringify({
        event_type: "webhook.create",
        actor_id: "forged-user",
        actor_type: "owner",
        resource_type: "webhook",
        resource_id: "wh-one",
        details: { password: "must-redact" },
      }),
    });
    expect(response.status).toBe(201);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      actor: "admin-one",
      actorType: "admin",
      requestId: "req-one",
      source: "supauth",
    }));
  });

  test("rejects product audit writes without a verified principal", async () => {
    trustedPrincipal.mockRejectedValueOnce(new AuthError("Verified management principal required"));
    const response = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      headers: delegationAttemptHeaders,
      body: JSON.stringify({
        event_type: "webhook.create",
        resource_type: "webhook",
        resource_id: "wh-one",
      }),
    });
    expect(response.status).toBe(401);
    expect(append).not.toHaveBeenCalled();
  });

  test("uses only the principal returned by the trusted BFF resolver", async () => {
    trustedPrincipal.mockResolvedValueOnce({
      id: "admin-sso-one",
      type: "admin",
      requestId: "req-delegated",
      platformAdmin: false,
    });
    const delegatedBody = JSON.stringify({
      event_type: "role.update",
      resource_type: "role",
      resource_id: "role-one",
    });
    const delegated = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      headers: delegationAttemptHeaders,
      body: delegatedBody,
    });
    const delegatedPayload = await delegated.json();
    expect({ status: delegated.status, payload: delegatedPayload }).toMatchObject({ status: 201 });
    expect(append).toHaveBeenLastCalledWith(expect.objectContaining({
      actor: "admin-sso-one",
      actorType: "admin",
      requestId: "req-delegated",
    }));

    trustedPrincipal.mockResolvedValueOnce({
      id: "master",
      type: "master",
      requestId: "req-one",
      platformAdmin: true,
    });
    const appendCount = append.mock.calls.length;
    const rejectedMaster = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      headers: {
        "x-supaoauth-actor-id": "forged-admin",
        "x-supaoauth-actor-type": "admin",
      },
      body: JSON.stringify({
        event_type: "role.update",
        resource_type: "role",
        resource_id: "role-one",
      }),
    });
    expect(rejectedMaster.status).toBe(403);
    expect(append).toHaveBeenCalledTimes(appendCount);
  });

  test("rejects audit event writes without delegation even for a direct admin transport", async () => {
    const response = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      body: JSON.stringify({
        event_type: "role.update",
        resource_type: "role",
        resource_id: "role-one",
      }),
    });
    expect(response.status).toBe(403);
    expect(append).not.toHaveBeenCalled();
  });

  test("exposes an integrity checkpoint", async () => {
    const response = await request("/v1/projects/proj_1/audit/integrity");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consistent: true, status: "verified" });
  });

  test("creates an export without returning inline content", async () => {
    const response = await request("/v1/projects/proj_1/audit/exports", {
      method: "POST",
      body: JSON.stringify({ format: "jsonl", limit: 100 }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "completed", row_count: 1 });
    expect(body.download_url).toContain("/audit/exports/");
    expect(body).not.toHaveProperty("content");
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(sqlQueryMock.mock.calls.some((call) => call[0].join("").includes("pg_advisory_xact_lock"))).toBe(true);
  });

  test("enforces read, export, and sensitive-detail capabilities", async () => {
    await request("/v1/projects/proj_1/audit");
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "audit.read");

    await request("/v1/projects/proj_1/audit/exports", {
      method: "POST",
      body: JSON.stringify({ format: "jsonl" }),
    });
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "audit.export");

    await request("/v1/projects/proj_1/audit/exports");
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "audit.export");

    const detail = await request(`/v1/projects/proj_1/audit/${auditRow.id}?include_sensitive=true`);
    expect(detail.status).toBe(200);
    expect(capability).toHaveBeenCalledWith("proj_1", expect.any(Object), "audit.read_sensitive");

    capability.mockRejectedValueOnce(new ForbiddenError("Missing collaborator capability: audit.read"));
    const denied = await request("/v1/projects/proj_1/audit");
    expect(denied.status).toBe(403);
  });

  test("requires audit.write for admin actors but accepts signed user and system appenders", async () => {
    const eventBody = JSON.stringify({
      event_type: "role.update",
      resource_type: "role",
      resource_id: "role-one",
    });
    const adminResponse = await request("/v1/projects/proj_1/audit/events", {
      method: "POST",
      headers: delegationAttemptHeaders,
      body: eventBody,
    });
    expect(adminResponse.status).toBe(201);
    expect(capability).toHaveBeenLastCalledWith("proj_1", expect.any(Object), "audit.write");

    for (const actorType of ["user", "system"]) {
      capability.mockClear();
      trustedPrincipal.mockResolvedValueOnce({
        id: `${actorType}-one`,
        type: actorType,
        requestId: `req-${actorType}`,
        platformAdmin: false,
      });
      const response = await request("/v1/projects/proj_1/audit/events", {
        method: "POST",
        headers: delegationAttemptHeaders,
        body: eventBody,
      });
      expect(response.status).toBe(201);
      expect(capability).not.toHaveBeenCalled();
    }
  });

  test("neutralizes spreadsheet formulas in CSV exports", async () => {
    const originalActor = auditRow.actor;
    auditRow.actor = "=HYPERLINK(\"https://example.test\")";
    try {
      const response = await request("/v1/projects/proj_1/audit/exports", {
        method: "POST",
        body: JSON.stringify({ format: "csv" }),
      });
      expect(response.status).toBe(201);
      const insertCall = sqlQueryMock.mock.calls.find((call) => call[0].join("").includes("INSERT INTO audit_exports"));
      const csv = insertCall?.slice(1).find((entry) => typeof entry === "string" && entry.includes("event_type"));
      expect(csv).toContain("\"'=HYPERLINK(\"\"https://example.test\"\")\"");
    } finally {
      auditRow.actor = originalActor;
    }
  });
});
