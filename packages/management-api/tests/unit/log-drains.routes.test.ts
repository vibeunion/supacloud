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

const { logDrainRoutes } = await import("../../src/routes/log-drains");
const app = new Elysia().use(logDrainRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("logDrainRoutes", () => {
  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
  });

  test("GET returns empty list when no drains configured", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);

    const res = await request("/v1/projects/proj_1/log-drains");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ project_ref: "proj_1" });
    expect(body.drains).toEqual([]);
  });

  test("POST persists a new drain and masks token on response", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: {} } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({
      ref,
      config: nextConfig,
    }) as never);

    const res = await request("/v1/projects/proj_1/log-drains", {
      method: "POST",
      body: JSON.stringify({
        name: "Production Logs",
        type: "datadog",
        url: "https://http-intake.logs.datadoghq.com/v1/input",
        token: "super-secret",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.drain).toMatchObject({
      name: "Production Logs",
      type: "datadog",
      has_token: true,
      token: "********",
      enabled: true,
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.log_drains).toHaveLength(1);
    expect(stored.log_drains[0].token).toBe("super-secret");
  });

  test("POST rejects invalid type and missing url", async () => {
    const badType = await request("/v1/projects/proj_1/log-drains", {
      method: "POST",
      body: JSON.stringify({ name: "x", type: "kafka", url: "https://example.com" }),
    });
    expect(badType.status).toBe(422);

    const missingUrl = await request("/v1/projects/proj_1/log-drains", {
      method: "POST",
      body: JSON.stringify({ name: "x", type: "webhook", url: "" }),
    });
    expect(missingUrl.status).toBe(400);
  });

  test("POST rejects local and private drain URLs", async () => {
    for (const url of ["http://127.0.0.1:9090/logs", "http://localhost/logs", "http://169.254.169.254/latest/meta-data"]) {
      const res = await request("/v1/projects/proj_1/log-drains", {
        method: "POST",
        body: JSON.stringify({ name: "unsafe", type: "webhook", url }),
      });
      expect(res.status).toBe(400);
    }
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("PATCH toggles enabled flag and persists", async () => {
    const existingDrain = {
      id: "drain-1",
      name: "Logs",
      type: "webhook",
      url: "https://example.com/log",
      enabled: true,
    };
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: { log_drains: [existingDrain] },
    } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({
      ref,
      config: nextConfig,
    }) as never);

    const res = await request("/v1/projects/proj_1/log-drains/drain-1", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drain.enabled).toBe(false);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.log_drains[0].enabled).toBe(false);
  });

  test("PATCH rejects replacing a drain URL with a private address", async () => {
    const existingDrain = {
      id: "drain-1",
      name: "Logs",
      type: "webhook",
      url: "https://example.com/log",
      enabled: true,
    };
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: { log_drains: [existingDrain] },
    } as never);

    const res = await request("/v1/projects/proj_1/log-drains/drain-1", {
      method: "PATCH",
      body: JSON.stringify({ url: "http://10.0.0.1/log" }),
    });

    expect(res.status).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("PATCH on unknown drain id returns 404", async () => {
    findByRef.mockResolvedValue({ ref: "proj_1", config: { log_drains: [] } } as never);

    const res = await request("/v1/projects/proj_1/log-drains/missing", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(404);
  });

  test("DELETE removes a drain", async () => {
    const drain = { id: "drain-2", name: "Logs", type: "loki", url: "https://loki/api/push", enabled: true };
    findByRef.mockResolvedValue({ ref: "proj_1", config: { log_drains: [drain] } } as never);
    updateConfig.mockImplementation(async (ref, nextConfig) => ({
      ref,
      config: nextConfig,
    }) as never);

    const res = await request("/v1/projects/proj_1/log-drains/drain-2", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ deleted: true, drain_id: "drain-2" });
    const stored = updateConfig.mock.calls[0][1];
    expect(stored.log_drains).toEqual([]);
  });

  test("GET masks token in listed drains", async () => {
    findByRef.mockResolvedValue({
      ref: "proj_1",
      config: {
        log_drains: [
          {
            id: "d1",
            name: "DD",
            type: "datadog",
            url: "https://intake/logs",
            token: "abc",
            enabled: true,
          },
        ],
      },
    } as never);

    const res = await request("/v1/projects/proj_1/log-drains");
    const body = await res.json();
    expect(body.drains[0]).toMatchObject({ has_token: true, token: "********" });
  });

  test("POST caps drains per project at 10", async () => {
    const drains = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      name: `d${i}`,
      type: "webhook",
      url: "https://example.com",
      enabled: true,
    }));
    findByRef.mockResolvedValue({ ref: "proj_1", config: { log_drains: drains } } as never);

    const res = await request("/v1/projects/proj_1/log-drains", {
      method: "POST",
      body: JSON.stringify({ name: "extra", type: "webhook", url: "https://example.com" }),
    });

    expect(res.status).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
