import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const createSchedule = mock((input: { schedule: unknown }) => Promise.resolve({
  kind: "created" as const,
  schedule: input.schedule,
}));
const updateSchedule = mock(() => Promise.resolve({ kind: "schedule_not_found" as const }));
const deleteSchedule = mock(() => Promise.resolve({ kind: "schedule_not_found" as const }));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));

const { projectRepository } = await import("../../src/repositories/project.repository");
const { scheduledFunctionService } = await import("../../src/services/scheduled-function.service");
const authModule = await import("../../src/middleware/auth");
const workerModule = await import("../../src/workers/scheduled-function.worker");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const createScheduleSpy = spyOn(scheduledFunctionService, "create").mockImplementation(
  createSchedule as typeof scheduledFunctionService.create,
);
const updateScheduleSpy = spyOn(scheduledFunctionService, "update").mockImplementation(
  updateSchedule as typeof scheduledFunctionService.update,
);
const deleteScheduleSpy = spyOn(scheduledFunctionService, "delete").mockImplementation(
  deleteSchedule as typeof scheduledFunctionService.delete,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const reloadSpy = spyOn(workerModule.scheduledFunctionWorker, "reload").mockImplementation(() => {});

const { scheduledFunctionRoutes } = await import("../../src/routes/scheduled-functions");
const { MAX_SCHEDULE_BODY_BYTES } = await import("../../src/utils/scheduled-function-config");
const app = new Elysia().use(scheduledFunctionRoutes);
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SCHEDULE_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const UPDATED_AT = "2026-08-11T00:00:00.000Z";
const NEXT_UPDATED_AT = "2026-08-11T00:00:00.001Z";

function storedSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    name: "Nightly",
    slug: "worker",
    cron: "0 2 * * *",
    method: "POST" as const,
    enabled: true,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
    }),
  );
}

function bodyWithSerializedBytes(serializedBytes: number): Record<string, string> {
  const emptyBodyBytes = new TextEncoder().encode(JSON.stringify({ payload: "" })).byteLength;
  return { payload: "x".repeat(serializedBytes - emptyBodyBytes) };
}

describe("scheduledFunctionRoutes", () => {
  afterAll(() => {
    findByRefSpy.mockRestore();
    createScheduleSpy.mockRestore();
    updateScheduleSpy.mockRestore();
    deleteScheduleSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    reloadSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    createSchedule.mockReset();
    createSchedule.mockImplementation(async (input) => ({ kind: "created", schedule: input.schedule }));
    updateSchedule.mockReset();
    updateSchedule.mockResolvedValue({ kind: "schedule_not_found" });
    deleteSchedule.mockReset();
    deleteSchedule.mockResolvedValue({ kind: "schedule_not_found" });
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    reloadSpy.mockClear();
  });

  test("GET returns empty list when no schedules", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    const res = await request("/v1/projects/proj_1/scheduled-functions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedules).toEqual([]);
  });

  test("GET exposes schedule metadata without stored body or header values", async () => {
    const bodySentinel = "private-body-sentinel";
    const headerSentinel = "private-header-sentinel";
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [{
          id: SCHEDULE_ID,
          name: "Nightly",
          slug: "worker",
          cron: "0 2 * * *",
          method: "POST",
          body: { token: bodySentinel },
          headers: { "x-schedule-token": headerSentinel },
          enabled: true,
          created_at: "2026-08-11T00:00:00.000Z",
          updated_at: "2026-08-11T00:00:00.000Z",
        }],
      },
    } as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions");
    const responseText = await res.text();
    const responseBody = JSON.parse(responseText);

    expect(res.status).toBe(200);
    expect(responseBody.schedules[0]).toMatchObject({
      body_empty: false,
      header_names: ["x-schedule-token"],
      updated_at: UPDATED_AT,
    });
    expect(responseBody.schedules[0]).not.toHaveProperty("body");
    expect(responseBody.schedules[0]).not.toHaveProperty("headers");
    expect(responseText).not.toContain(bodySentinel);
    expect(responseText).not.toContain(headerSentinel);
  });

  test("GET by ID returns the exact schedule revision without private payload values", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: { scheduled_functions: [storedSchedule({ body: { private: "sentinel" } })] },
    } as never);

    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`);
    const responseText = await res.text();
    const responseBody = JSON.parse(responseText);

    expect(res.status).toBe(200);
    expect(responseBody.schedule).toMatchObject({ id: SCHEDULE_ID, updated_at: UPDATED_AT });
    expect(responseText).not.toContain("sentinel");
  });

  test("GET rejects an invalid project ref before authorization or repository access", async () => {
    const res = await request("/v1/projects/bad.ref/scheduled-functions");

    expect(res.status).toBe(400);
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(findByRef).not.toHaveBeenCalled();
  });

  test("POST creates a schedule and signals worker reload", async () => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        name: "Nightly Cleanup",
        slug: "cleanup",
        cron: "0 2 * * *",
        method: "POST",
        body: { mode: "deep" },
        headers: { "X-Schedule-Token": "token" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.request_id).toBe(REQUEST_ID);
    expect(body.schedule).toMatchObject({
      name: "Nightly Cleanup",
      slug: "cleanup",
      cron: "0 2 * * *",
      method: "POST",
      enabled: true,
      body_empty: false,
      header_names: ["x-schedule-token"],
    });
    expect(body.schedule).not.toHaveProperty("body");
    expect(body.schedule).not.toHaveProperty("headers");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const stored = createSchedule.mock.calls[0][0].schedule as Record<string, unknown>;
    expect(stored.body).toEqual({ mode: "deep" });
    expect(stored.headers).toEqual({ "x-schedule-token": "token" });
  });

  test("POST rejects invalid cron and slug", async () => {
    const badCron = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "x", slug: "fn", cron: "not-cron", method: "POST" }),
    });
    expect(badCron.status).toBe(400);

    const badSlug = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "x", slug: "bad slug!", cron: "* * * * *", method: "POST" }),
    });
    expect(badSlug.status).toBe(400);
  });

  test("POST rejects a slug the worker cannot invoke", async () => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        name: "x",
        slug: "a".repeat(129),
        cron: "* * * * *",
        method: "POST",
      }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test.each([
    "0-999999999 * * * *",
    "*/999999999 * * * *",
    "60 * * * *",
    "*/0 * * * *",
  ])("POST rejects unsafe cron %s before repository writes", async (cron) => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "x", slug: "fn", cron, method: "POST" }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test.each([
    ["reserved routing header", { "X-Project-Ref": "other-project" }],
    ["reserved auth header", { Authorization: "private-auth-sentinel" }],
    ["host header", { Host: "attacker.invalid" }],
    ["hop-by-hop header", { Connection: "keep-alive" }],
    ["framing header", { "Content-Length": "5" }],
    ["transfer framing header", { "Transfer-Encoding": "chunked" }],
    ["TE header", { TE: "trailers" }],
    ["trailer header", { Trailer: "x-checksum" }],
    ["upgrade header", { Upgrade: "websocket" }],
    ["proxy auth header", { "Proxy-Authorization": "private-proxy-sentinel" }],
    ["standard forwarded header", { Forwarded: "host=attacker.invalid" }],
    ["forwarded header", { "X-Forwarded-Host": "attacker.invalid" }],
    ["case-insensitive duplicate", { "X-Schedule-Token": "one", "x-schedule-token": "two" }],
    ["invalid value", { "x-schedule-token": "private-invalid-sentinel\n" }],
  ])("POST rejects %s without exposing header values", async (_label, headers) => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "x", slug: "fn", cron: "* * * * *", method: "POST", headers }),
    });
    const responseBody = await res.text();

    expect(res.status).toBe(400);
    expect(responseBody).toContain("SCHEDULE_HEADERS_INVALID");
    expect(responseBody).not.toContain("private-");
    expect(findByRef).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test("POST rejects duplicate slug with 409", async () => {
    createSchedule.mockResolvedValue({ kind: "duplicate", field: "slug" });

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "new", slug: "cleanup", cron: "0 1 * * *", method: "POST" }),
    });
    expect(res.status).toBe(409);
  });

  test("POST checks duplicate slugs after normalization", async () => {
    createSchedule.mockResolvedValue({ kind: "duplicate", field: "slug" });

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "dup", slug: " cleanup ", cron: "0 1 * * *", method: "POST" }),
    });

    expect(res.status).toBe(409);
    expect((createSchedule.mock.calls[0][0].schedule as Record<string, unknown>).slug).toBe("cleanup");
  });

  test("POST maps an atomic duplicate name outcome to 409 without worker reload", async () => {
    createSchedule.mockResolvedValue({ kind: "duplicate", field: "name" });

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        name: "Nightly",
        slug: "other-worker",
        cron: "0 1 * * *",
        method: "POST",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCHEDULE_NAME_CONFLICT" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("PATCH toggles enabled", async () => {
    updateSchedule.mockResolvedValue({
      kind: "updated",
      schedule: storedSchedule({ enabled: false, updated_at: NEXT_UPDATED_AT }),
    });

    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT, enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.enabled).toBe(false);
    expect(body.request_id).toBe(REQUEST_ID);
    expect(body.previous_updated_at).toBe(UPDATED_AT);
    expect(updateSchedule.mock.calls[0][0]).toMatchObject({
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: UPDATED_AT,
      patch: { enabled: false },
    });
  });

  test.each([
    ` ${UPDATED_AT}`,
    "2026-08-11T00:00:00Z",
    "2026-08-11T08:00:00.000+08:00",
    "2026-02-30T00:00:00.000Z",
  ])("PATCH rejects non-canonical expected_updated_at %j before mutation", async (expectedUpdatedAt) => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: expectedUpdatedAt, enabled: false }),
    });

    expect(res.status).toBe(400);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test("PATCH returns 409 for a stale revision without worker reload", async () => {
    updateSchedule.mockResolvedValue({ kind: "revision_conflict" });

    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT, enabled: false }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCHEDULE_REVISION_CONFLICT" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("PATCH rejects unsafe cron before repository writes", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT, cron: "0-999999999 * * * *" }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test("PATCH rejects platform headers before repository writes", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        expected_updated_at: UPDATED_AT,
        headers: { apikey: "private-api-key-sentinel" },
      }),
    });
    const responseBody = await res.text();

    expect(res.status).toBe(400);
    expect(responseBody).toContain("SCHEDULE_HEADERS_INVALID");
    expect(responseBody).not.toContain("private-api-key-sentinel");
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test.each(["PATCH", "DELETE"])("%s rejects a non-canonical schedule ID before repository access", async (method) => {
    const revisionQuery = method === "DELETE"
      ? `?expected_updated_at=${encodeURIComponent(UPDATED_AT)}`
      : "";
    const res = await request(`/v1/projects/proj_1/scheduled-functions/not-a-uuid${revisionQuery}`, {
      method,
      ...(method === "PATCH" ? {
        body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT, name: "Unsafe" }),
      } : {}),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(deleteSchedule).not.toHaveBeenCalled();
  });

  test.each(["", " ", "x".repeat(121)])("PATCH rejects invalid name %j before repository access", async (name) => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT, name }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test("PATCH rejects a request ID without mutation fields", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, expected_updated_at: UPDATED_AT }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  test("POST accepts a body exactly 1 MiB after JSON serialization", async () => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        name: "Boundary",
        slug: "worker",
        cron: "* * * * *",
        method: "POST",
        body: bodyWithSerializedBytes(MAX_SCHEDULE_BODY_BYTES),
      }),
    });

    expect(res.status).toBe(200);
    expect(createSchedule).toHaveBeenCalledTimes(1);
  });

  test("POST rejects a serialized body over 1 MiB without repository access", async () => {
    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        request_id: REQUEST_ID,
        name: "Oversized",
        slug: "worker",
        cron: "* * * * *",
        method: "POST",
        body: bodyWithSerializedBytes(MAX_SCHEDULE_BODY_BYTES + 1),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("SCHEDULE_BODY_INVALID");
    expect(findByRef).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  test("DELETE removes schedule", async () => {
    deleteSchedule.mockResolvedValue({ kind: "deleted", deletedUpdatedAt: UPDATED_AT });

    const res = await request(
      `/v1/projects/proj_1/scheduled-functions/${OTHER_SCHEDULE_ID}?expected_updated_at=${encodeURIComponent(UPDATED_AT)}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, deleted_updated_at: UPDATED_AT });
    expect(deleteSchedule.mock.calls[0][0]).toEqual({
      ref: "proj_1",
      scheduleId: OTHER_SCHEDULE_ID,
      expectedUpdatedAt: UPDATED_AT,
    });
  });

  test.each([
    ` ${UPDATED_AT}`,
    "2026-08-11T00:00:00Z",
    "2026-08-11T08:00:00.000+08:00",
  ])("DELETE rejects non-canonical expected_updated_at %j before mutation", async (expectedUpdatedAt) => {
    const res = await request(
      `/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}?expected_updated_at=${encodeURIComponent(expectedUpdatedAt)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(400);
    expect(deleteSchedule).not.toHaveBeenCalled();
  });

  test("DELETE returns 409 for a stale revision without worker reload", async () => {
    deleteSchedule.mockResolvedValue({ kind: "revision_conflict" });

    const res = await request(
      `/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}?expected_updated_at=${encodeURIComponent(UPDATED_AT)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCHEDULE_REVISION_CONFLICT" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
