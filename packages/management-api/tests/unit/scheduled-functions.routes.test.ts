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
const app = new Elysia().use(scheduledFunctionRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
    }),
  );
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

  test("POST creates a schedule and signals worker reload", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({
        name: "Nightly Cleanup",
        slug: "cleanup",
        cron: "0 2 * * *",
        method: "POST",
        body: { mode: "deep" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.schedule).toMatchObject({
      name: "Nightly Cleanup",
      slug: "cleanup",
      cron: "0 2 * * *",
      method: "POST",
      enabled: true,
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.scheduled_functions[0].body).toEqual({ mode: "deep" });
  });

  test("POST rejects invalid cron and slug", async () => {
    const badCron = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ name: "x", slug: "fn", cron: "not-cron", method: "POST" }),
    });
    expect(badCron.status).toBe(400);

    const badSlug = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ name: "x", slug: "bad slug!", cron: "* * * * *", method: "POST" }),
    });
    expect(badSlug.status).toBe(400);
  });

  test("POST rejects duplicate slug with 409", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: "s1", name: "old", slug: "cleanup", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions", {
      method: "POST",
      body: JSON.stringify({ name: "new", slug: "cleanup", cron: "0 1 * * *", method: "POST" }),
    });
    expect(res.status).toBe(409);
  });

  test("PATCH toggles enabled", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: "s1", name: "old", slug: "fn", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions/s1", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.enabled).toBe(false);
  });

  test("DELETE removes schedule", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        scheduled_functions: [
          { id: "s2", name: "old", slug: "fn", cron: "0 0 * * *", method: "GET", enabled: true, created_at: "", updated_at: "" },
        ],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({ ref, config: nextConfig }) as never);

    const res = await request("/v1/projects/proj_1/scheduled-functions/s2", { method: "DELETE" });
    expect(res.status).toBe(200);
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.scheduled_functions).toEqual([]);
  });
});
