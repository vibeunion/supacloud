import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");
const workerModule = await import("../../src/workers/scheduled-function.worker");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(
  updateConfig as typeof projectRepository.updateConfig,
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
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    reloadSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
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
    });
    expect(responseBody.schedules[0]).not.toHaveProperty("body");
    expect(responseBody.schedules[0]).not.toHaveProperty("headers");
    expect(responseText).not.toContain(bodySentinel);
    expect(responseText).not.toContain(headerSentinel);
  });

  test("GET rejects an invalid project ref before authorization or repository access", async () => {
    const res = await request("/v1/projects/bad.ref/scheduled-functions");

    expect(res.status).toBe(400);
    expect(requireProjectOrAdminAuth).not.toHaveBeenCalled();
    expect(findByRef).not.toHaveBeenCalled();
  });

  test("POST creates a schedule and signals worker reload", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

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
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.scheduled_functions[0].body).toEqual({ mode: "deep" });
    expect(stored.scheduled_functions[0].headers).toEqual({ "x-schedule-token": "token" });
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
    expect(updateConfig).not.toHaveBeenCalled();
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
    expect(updateConfig).not.toHaveBeenCalled();
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
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("POST rejects duplicate slug with 409", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: SCHEDULE_ID, name: "old", slug: "cleanup", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "new", slug: "cleanup", cron: "0 1 * * *", method: "POST" }),
    });
    expect(res.status).toBe(409);
  });

  test("POST checks duplicate slugs after normalization", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: SCHEDULE_ID, name: "old", slug: "cleanup", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ request_id: REQUEST_ID, name: "dup", slug: " cleanup ", cron: "0 1 * * *", method: "POST" }),
    });

    expect(res.status).toBe(409);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("PATCH toggles enabled", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: SCHEDULE_ID, name: "old", slug: "fn", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.enabled).toBe(false);
    expect(body.request_id).toBe(REQUEST_ID);
  });

  test("PATCH rejects unsafe cron before repository writes", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, cron: "0-999999999 * * * *" }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("PATCH rejects platform headers before repository writes", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, headers: { apikey: "private-api-key-sentinel" } }),
    });
    const responseBody = await res.text();

    expect(res.status).toBe(400);
    expect(responseBody).toContain("SCHEDULE_HEADERS_INVALID");
    expect(responseBody).not.toContain("private-api-key-sentinel");
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test.each(["PATCH", "DELETE"])("%s rejects a non-canonical schedule ID before repository access", async (method) => {
    const res = await request("/v1/projects/proj_1/scheduled-functions/not-a-uuid", {
      method,
      ...(method === "PATCH" ? { body: JSON.stringify({ request_id: REQUEST_ID, name: "Unsafe" }) } : {}),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test.each(["", " ", "x".repeat(121)])("PATCH rejects invalid name %j before repository access", async (name) => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID, name }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("PATCH rejects a request ID without mutation fields", async () => {
    const res = await request(`/v1/projects/proj_1/scheduled-functions/${SCHEDULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ request_id: REQUEST_ID }),
    });

    expect(res.status).toBe(400);
    expect(findByRef).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("POST accepts a body exactly 1 MiB after JSON serialization", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);
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
    expect(updateConfig).toHaveBeenCalledTimes(1);
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
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("DELETE removes schedule", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: OTHER_SCHEDULE_ID, name: "old", slug: "fn", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

    const res = await request(`/v1/projects/proj_1/scheduled-functions/${OTHER_SCHEDULE_ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.scheduled_functions).toEqual([]);
  });
});
