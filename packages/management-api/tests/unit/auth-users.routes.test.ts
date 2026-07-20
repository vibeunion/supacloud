import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { config } from "../../src/config";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProject = mock(() => Promise.resolve({ ref: "proj_1", config: {} }));
const resolveProjectServiceRoleKey = mock(() => Promise.resolve("service-role-key"));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const serviceRoleModule = await import("../../src/utils/service-role");
const userSafetyModule = await import("../../src/services/user-safety.service");
const dbModule = await import("../../src/db");

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000101";
const NEXT_OPERATION_ID = "00000000-0000-4000-8000-000000000102";
const checkUserActiveTasks = mock(() => Promise.resolve({
  safe: true,
  activeTaskCount: 0,
  activeTasks: [],
}));
const beginUserDeletion = mock(async (input: {
  projectRef: string;
  userId: string;
  requestId: string;
  shouldSoftDelete: boolean;
}) => {
  const taskSafety = await checkUserActiveTasks(input.projectRef, input.userId);
  return taskSafety.safe
    ? { state: "ready" as const, normalizedUserId: input.userId, operationId: OPERATION_ID }
    : { state: "blocked" as const, ...taskSafety };
});
const resumeUserDeletionAfterReconcile = mock(() => Promise.resolve({
  state: "ready" as const,
  normalizedUserId: USER_ID,
  operationId: NEXT_OPERATION_ID,
}));
const markUserDeletionStarted = mock(() => Promise.resolve());
const completeUserDeletion = mock(() => Promise.resolve());
const failUserDeletion = mock(() => Promise.resolve(true));
const recordUserDeletionUncertainty = mock(() => Promise.resolve(true));

let grantsTableAvailable = true;
const tenantDb = mock((strings: TemplateStringsArray) => {
  const text = strings.join("?");
  if (text.includes("FROM auth.sessions AS session")) {
    return Promise.resolve([
      {
        session_id: "session-aal2",
        created_at: new Date("2026-07-19T00:00:00.000Z"),
        updated_at: new Date("2026-07-19T00:05:00.000Z"),
        aal: "aal2",
        amr: [{ method: "totp", created_at: "2026-07-19T00:01:00.000Z" }],
        total_count: "2",
      },
      {
        session_id: "session-aal1",
        created_at: new Date("2026-07-18T00:00:00.000Z"),
        updated_at: new Date("2026-07-18T00:05:00.000Z"),
        aal: "aal1",
        amr: [],
        total_count: "2",
      },
    ]);
  }
  if (text.includes("FROM auth.users")) return Promise.resolve([{ id: "user-one" }]);
  if (text.includes("FROM auth.oauth_consents")) {
    if (!grantsTableAvailable) throw Object.assign(new Error("missing oauth_consents"), { code: "42P01" });
    return Promise.resolve([{
      id: "grant-one",
      user_id: "user-one",
      client_id: "client-one",
      scopes: "openid profile email",
      client_name: "Example app",
      granted_at: new Date("2026-07-19T00:00:00.000Z"),
      revoked_at: null,
    }]);
  }
  return Promise.resolve([]);
});
(tenantDb as typeof tenantDb & { begin: (callback: (tx: typeof tenantDb) => Promise<unknown>) => Promise<unknown> }).begin =
  mock((callback) => callback(tenantDb));
const resolveDbNameSpy = spyOn(dbModule, "resolveDbName").mockResolvedValue("supa_proj_1");
const getProjectDbSpy = spyOn(dbModule, "getProjectDb").mockReturnValue(tenantDb as never);

const requireProjectOrAdminAuthSpy = spyOn(
  authModule,
  "requireProjectOrAdminAuth",
).mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSpy = spyOn(servicesModule.projectService, "getProject").mockImplementation(
  getProject as typeof servicesModule.projectService.getProject,
);
const resolveProjectServiceRoleKeySpy = spyOn(
  serviceRoleModule,
  "resolveProjectServiceRoleKey",
).mockImplementation(
  resolveProjectServiceRoleKey as typeof serviceRoleModule.resolveProjectServiceRoleKey,
);
const beginUserDeletionSpy = spyOn(userSafetyModule, "beginUserDeletion").mockImplementation(
  beginUserDeletion as typeof userSafetyModule.beginUserDeletion,
);
const resumeUserDeletionAfterReconcileSpy = spyOn(
  userSafetyModule,
  "resumeUserDeletionAfterReconcile",
).mockImplementation(
  resumeUserDeletionAfterReconcile as typeof userSafetyModule.resumeUserDeletionAfterReconcile,
);
const markUserDeletionStartedSpy = spyOn(
  userSafetyModule,
  "markUserDeletionStarted",
).mockImplementation(markUserDeletionStarted as typeof userSafetyModule.markUserDeletionStarted);
const completeUserDeletionSpy = spyOn(userSafetyModule, "completeUserDeletion").mockImplementation(
  completeUserDeletion as typeof userSafetyModule.completeUserDeletion,
);
const failUserDeletionSpy = spyOn(userSafetyModule, "failUserDeletion").mockImplementation(
  failUserDeletion as typeof userSafetyModule.failUserDeletion,
);
const recordUserDeletionUncertaintySpy = spyOn(
  userSafetyModule,
  "recordUserDeletionUncertainty",
).mockImplementation(
  recordUserDeletionUncertainty as typeof userSafetyModule.recordUserDeletionUncertainty,
);

const { userManagementRoutes } = await import("../../src/routes/auth-users");
const app = new Elysia().use(swagger()).use(userManagementRoutes);
const originalFetch = globalThis.fetch;

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("userManagementRoutes", () => {
  const userUpdateMethods: string[] = [];
  const userUpdateBodies: Array<Record<string, unknown>> = [];

  afterAll(() => {
    globalThis.fetch = originalFetch;
    requireProjectOrAdminAuthSpy.mockRestore();
    getProjectSpy.mockRestore();
    resolveProjectServiceRoleKeySpy.mockRestore();
    beginUserDeletionSpy.mockRestore();
    resumeUserDeletionAfterReconcileSpy.mockRestore();
    markUserDeletionStartedSpy.mockRestore();
    completeUserDeletionSpy.mockRestore();
    failUserDeletionSpy.mockRestore();
    recordUserDeletionUncertaintySpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    getProjectDbSpy.mockRestore();
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProject.mockReset();
    getProject.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    resolveProjectServiceRoleKey.mockReset();
    resolveProjectServiceRoleKey.mockResolvedValue("service-role-key" as never);
    checkUserActiveTasks.mockReset();
    checkUserActiveTasks.mockResolvedValue({
      safe: true,
      activeTaskCount: 0,
      activeTasks: [],
    });
    beginUserDeletion.mockReset();
    beginUserDeletion.mockImplementation(async (input) => {
      const taskSafety = await checkUserActiveTasks(input.projectRef, input.userId);
      return taskSafety.safe
        ? { state: "ready", normalizedUserId: input.userId, operationId: OPERATION_ID }
        : { state: "blocked", ...taskSafety };
    });
    resumeUserDeletionAfterReconcile.mockReset();
    resumeUserDeletionAfterReconcile.mockResolvedValue({
      state: "ready",
      normalizedUserId: USER_ID,
      operationId: NEXT_OPERATION_ID,
    });
    markUserDeletionStarted.mockReset();
    markUserDeletionStarted.mockResolvedValue();
    completeUserDeletion.mockReset();
    completeUserDeletion.mockResolvedValue();
    failUserDeletion.mockReset();
    failUserDeletion.mockResolvedValue(true);
    recordUserDeletionUncertainty.mockReset();
    recordUserDeletionUncertainty.mockResolvedValue(true);
    userUpdateMethods.length = 0;
    userUpdateBodies.length = 0;
    grantsTableAvailable = true;
  });

  test("PATCH user updates proxy to GoTrue with PUT for compatibility", async () => {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      userUpdateMethods.push(init?.method ?? "GET");
      if (typeof init?.body === "string") {
        userUpdateBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Response.json({ id: "user-one", email: "worker@example.test" });
    }) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users/user-one", {
      method: "PATCH",
      body: JSON.stringify({
        user_metadata: {
          houqin_profile_id: "profile-one",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(userUpdateMethods).toEqual(["PUT"]);
    expect(userUpdateBodies[0]).toEqual({
      user_metadata: {
        houqin_profile_id: "profile-one",
      },
    });
  });

  test("returns stable GoTrue errors when the upstream body is null", async () => {
    globalThis.fetch = mock(async () => Response.json(null, { status: 405 })) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users/user-one", {
      method: "PATCH",
      body: JSON.stringify({
        user_metadata: {
          houqin_profile_id: "profile-one",
        },
      }),
    });

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
      message: "Failed to update user",
      code: "405",
    });
  });

  test("rejects SupaOAuth authorization metadata before calling GoTrue", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: "should-not-be-created" });
    }) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users", {
      method: "POST",
      body: JSON.stringify({
        email: "operator@example.test",
        app_metadata: {
          supaoauth: { permissions: ["tenant.members.manage"] },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "FORBIDDEN_USER_MUTATION",
      field: "app_metadata.supaoauth",
    });
    expect(upstreamCalls).toBe(0);
  });

  test("does not expose GoTrue role and password-hash mutation fields", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: "should-not-be-updated" });
    }) as unknown as typeof fetch;

    const res = await request("/v1/projects/proj_1/auth/users/user-one", {
      method: "PATCH",
      body: JSON.stringify({ role: "service_role", password_hash: "injected" }),
    });

    expect(res.status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });

  test("lists OAuth grants from GoTrue's authoritative tenant tables", async () => {
    const res = await request("/v1/projects/proj_1/auth/users/user-one/grants");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "gotrue",
      total: 1,
      items: [{ id: "grant-one", client_id: "client-one", scopes: ["openid", "profile", "email"] }],
    });
  });

  test("lists authoritative GoTrue session AAL and AMR without a local session store", async () => {
    const res = await request("/v1/projects/proj_1/auth/users/00000000-0000-4000-8000-000000000001/sessions?page=1&limit=20");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          session_id: "session-aal2",
          created_at: "2026-07-19T00:00:00.000Z",
          updated_at: "2026-07-19T00:05:00.000Z",
          aal: "aal2",
          amr: [{ method: "totp", created_at: "2026-07-19T00:01:00.000Z" }],
        },
        {
          session_id: "session-aal1",
          created_at: "2026-07-18T00:00:00.000Z",
          updated_at: "2026-07-18T00:05:00.000Z",
          aal: "aal1",
          amr: [],
        },
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
  });

  test("rejects a non-GoTrue user id before querying authoritative sessions", async () => {
    const res = await request("/v1/projects/proj_1/auth/users/not-a-uuid/sessions");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "VALIDATION_ERROR",
      message: "GoTrue user id must be a UUID",
    });
  });

  test("deletes a task-safe user only through the GoTrue Admin API", async () => {
    const upstreamRequests: Array<{
      url: string;
      method: string;
      body: string | null;
      signal: AbortSignal | null | undefined;
    }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      upstreamRequests.push({
        url: String(input),
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? init.body : null,
        signal: init?.signal,
      });
      return Response.json({ id: USER_ID, deleted_at: "2026-07-20T00:00:00.000Z" });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, {
      method: "DELETE",
      body: JSON.stringify({ should_soft_delete: true }),
    });

    expect(res.status).toBe(200);
    expect(checkUserActiveTasks).toHaveBeenCalledWith("proj_1", USER_ID);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ should_soft_delete: true }),
    });
    expect(upstreamRequests[0].url).toEndWith(`/admin/users/${USER_ID}`);
    expect(upstreamRequests[1]).toMatchObject({
      method: "GET",
      body: null,
    });
    expect(upstreamRequests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(markUserDeletionStarted).toHaveBeenCalledTimes(1);
    expect(markUserDeletionStarted).toHaveBeenCalledWith({
      projectRef: "proj_1",
      userId: USER_ID,
      operationId: OPERATION_ID,
    });
    expect(completeUserDeletion).toHaveBeenCalledTimes(1);
  });

  test("uses a trusted direct GoTrue URL without falling back through the SDK proxy", async () => {
    const upstreamUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      upstreamUrls.push(String(input));
      return upstreamUrls.length === 1
        ? Response.json({ id: USER_ID })
        : Response.json({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${config.masterToken}`,
        "x-supacloud-direct-gotrue-url": "http://127.0.0.1:8361",
      },
    });

    expect(res.status).toBe(200);
    expect(upstreamUrls).toEqual([
      `http://127.0.0.1:8361/admin/users/${USER_ID}`,
      `http://127.0.0.1:8361/admin/users/${USER_ID}`,
    ]);
  });

  test("fails closed when external auth owns the user endpoint", async () => {
    getProject.mockResolvedValueOnce({
      ref: "proj_1",
      config: {
        auth: {
          third_party_auth: {
            enabled: true,
            auth_endpoint_mode: "external",
            auth_upstream: "https://identity.example.test",
          },
        },
      },
    } as never);
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: USER_ID });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "external_auth_user_deletion_unavailable",
    });
    expect(beginUserDeletion).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(0);
  });

  test("does not call GoTrue when the deletion operation lease expires before mark", async () => {
    markUserDeletionStarted.mockRejectedValueOnce(new Error("deletion lease expired"));
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: USER_ID });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason_code: "user_deletion_state_unavailable" });
    expect(upstreamCalls).toBe(0);
  });

  test("reconciles an expired operation before allocating a new operation and re-sending DELETE", async () => {
    beginUserDeletion.mockResolvedValueOnce({
      state: "reconcile",
      status: "deleting",
      requestId: "request-old",
      operationId: OPERATION_ID,
      shouldSoftDelete: false,
    });
    const methods: string[] = [];
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method || "GET");
      if (methods.length === 1) return Response.json({ id: USER_ID, deleted_at: null });
      if (methods.length === 2) return Response.json({ id: USER_ID });
      return Response.json({ message: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(methods).toEqual(["GET", "DELETE", "GET"]);
    expect(resumeUserDeletionAfterReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: "proj_1", userId: USER_ID }),
      OPERATION_ID,
    );
    expect(markUserDeletionStarted).toHaveBeenCalledWith({
      projectRef: "proj_1",
      userId: USER_ID,
      operationId: NEXT_OPERATION_ID,
    });
    expect(completeUserDeletion).toHaveBeenCalledWith({
      projectRef: "proj_1",
      userId: USER_ID,
      operationId: NEXT_OPERATION_ID,
    });
  });

  test("blocks GoTrue user deletion while platform tasks are active", async () => {
    checkUserActiveTasks.mockResolvedValueOnce({
      safe: false,
      activeTaskCount: 1,
      activeTasks: [{ id: "task-one", task_type: "edge_function", status: "running" }],
    });
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: USER_ID });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "USER_HAS_ACTIVE_TASKS",
      message: "User deletion is blocked while background tasks are active",
      active_task_count: 1,
      active_tasks: [{ id: "task-one", task_type: "edge_function", status: "running" }],
    });
    expect(upstreamCalls).toBe(0);
  });

  test("fails closed when active task state cannot be verified", async () => {
    checkUserActiveTasks.mockRejectedValueOnce(new Error("task database unavailable"));
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: USER_ID });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "User deletion safety state is unavailable; GoTrue was not called",
      reason_code: "user_deletion_fence_unavailable",
    });
    expect(upstreamCalls).toBe(0);
  });

  test("marks the fence failed only after read-back confirms the user is active", async () => {
    let upstreamCall = 0;
    globalThis.fetch = mock(async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) {
        return Response.json({ message: "delete failed", code: "unexpected_failure" }, { status: 500 });
      }
      return Response.json({ id: USER_ID, deleted_at: null });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(failUserDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: "proj_1", userId: USER_ID }),
      "delete failed",
    );
    expect(completeUserDeletion).not.toHaveBeenCalled();
  });

  test("keeps the deletion fence active when GoTrue read-back is unavailable", async () => {
    let upstreamCall = 0;
    globalThis.fetch = mock(async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) return Response.json({ id: USER_ID });
      return Response.json({ message: "read-back unavailable" }, { status: 503 });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      reason_code: "gotrue_user_deletion_readback_unavailable",
    });
    expect(failUserDeletion).not.toHaveBeenCalled();
    expect(completeUserDeletion).not.toHaveBeenCalled();
    expect(recordUserDeletionUncertainty).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      "read-back unavailable",
    );
  });

  test("keeps the fence active after an ambiguous DELETE transport failure", async () => {
    let upstreamCall = 0;
    globalThis.fetch = mock(async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) throw new Error("connection reset after request write");
      return Response.json({ id: USER_ID, deleted_at: null });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      reason_code: "gotrue_user_deletion_transport_uncertain",
    });
    expect(failUserDeletion).not.toHaveBeenCalled();
    expect(recordUserDeletionUncertainty).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.stringContaining("connection reset after request write"),
    );
  });

  test("reconciles a GoTrue 404 delete response through authoritative read-back", async () => {
    globalThis.fetch = mock(async () => (
      Response.json({ message: "not found" }, { status: 404 })
    )) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: USER_ID, deleted: true, deletion_status: "deleted" });
    expect(completeUserDeletion).toHaveBeenCalledTimes(1);
    expect(failUserDeletion).not.toHaveBeenCalled();
  });

  test("does not issue concurrent GoTrue deletes for an active deletion fence", async () => {
    beginUserDeletion.mockResolvedValueOnce({
      state: "in_progress",
      status: "deleting",
      requestId: "req-existing",
      operationId: OPERATION_ID,
    });
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return Response.json({ id: USER_ID });
    }) as unknown as typeof fetch;

    const res = await request(`/v1/projects/proj_1/auth/users/${USER_ID}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "USER_DELETION_IN_PROGRESS",
      request_id: "req-existing",
    });
    expect(upstreamCalls).toBe(0);
  });

  test("returns 501 for session-specific revoke instead of deleting GoTrue session rows", async () => {
    const res = await request(
      "/v1/projects/proj_1/auth/users/00000000-0000-4000-8000-000000000001/sessions/00000000-0000-4000-8000-000000000002/revoke",
      { method: "POST" },
    );

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_admin_session_revoke_unavailable",
    });
    expect(tenantDb.mock.calls.some(([strings]) => /DELETE\s+FROM\s+auth\.sessions/i.test(strings.join("?")))).toBe(false);
  });

  test("returns 501 for admin identity unlink instead of mutating auth.identities", async () => {
    const res = await request(
      "/v1/projects/proj_1/auth/users/00000000-0000-4000-8000-000000000001/identities/00000000-0000-4000-8000-000000000003",
      { method: "DELETE" },
    );

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_admin_identity_unlink_unavailable",
    });
    expect(tenantDb.mock.calls.some(([strings]) => /DELETE\s+FROM\s+auth\.identities/i.test(strings.join("?")))).toBe(false);
  });

  test("returns 501 because stock GoTrue has no admin grant-specific revoke API", async () => {
    const res = await request("/v1/projects/proj_1/auth/users/user-one/grants/client-one", {
      method: "DELETE",
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_admin_grant_revoke_unavailable",
    });
    const databaseWrites = tenantDb.mock.calls.filter(([strings]) => (
      /UPDATE\s+auth\.oauth_consents|DELETE\s+FROM\s+auth\.sessions/i.test(strings.join("?"))
    ));
    expect(databaseWrites).toHaveLength(0);
  });

  test("returns 501 instead of a fake empty grant list when GoTrue lacks OAuth server tables", async () => {
    grantsTableAvailable = false;
    const res = await request("/v1/projects/proj_1/auth/users/user-one/grants");
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "gotrue_oauth_server_not_available",
    });
  });

  test("keeps unsupported admin mutations out of OpenAPI", async () => {
    const response = await request("/swagger/json");
    const specification = await response.json() as { paths: Record<string, unknown> };

    expect(specification.paths).not.toHaveProperty(
      "/v1/projects/{ref}/auth/users/{id}/sessions/{sessionId}/revoke",
    );
    expect(specification.paths).not.toHaveProperty(
      "/v1/projects/{ref}/auth/users/{id}/identities/{identityId}",
    );
    expect(specification.paths).not.toHaveProperty(
      "/v1/projects/{ref}/auth/users/{id}/grants/{clientId}",
    );
  });
});
