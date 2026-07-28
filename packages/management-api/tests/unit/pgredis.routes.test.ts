import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { createPgredisRoutes } from "../../src/routes/pgredis";
import { AppError } from "../../src/utils/errors";

const platformStatus = mock(() => Promise.resolve({ ok: true, activeTenants: 1 }));
const projectStatus = mock((projectRef: string) => Promise.resolve({ projectRef, configured: true }));
const execute = mock(() => Promise.resolve({ written: true }));
const flush = mock(() => Promise.resolve({ deleted: 3 }));
const requireAdmin = mock(() => Promise.resolve(undefined));
const requireProject = mock(() => Promise.resolve(undefined));
const findProject = mock((ref: string) => Promise.resolve({ ref }));

const app = new Elysia().use(createPgredisRoutes({
  service: { platformStatus, projectStatus, execute, flush },
  requireAdmin,
  requireProject,
  findProject: findProject as never,
}));

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  return app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

describe("pgredis routes", () => {
  beforeEach(() => {
    platformStatus.mockClear();
    projectStatus.mockClear();
    execute.mockClear();
    flush.mockClear();
    requireAdmin.mockReset();
    requireAdmin.mockResolvedValue(undefined);
    requireProject.mockReset();
    requireProject.mockResolvedValue(undefined);
    findProject.mockReset();
    findProject.mockImplementation((ref: string) => Promise.resolve({ ref }));
  });

  test("exposes platform and project status through authenticated routes", async () => {
    expect((await request("/v1/cache")).status).toBe(200);
    const projectResponse = await request("/v1/projects/tenant-a/cache");
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toEqual({ projectRef: "tenant-a", configured: true });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireProject).toHaveBeenCalledTimes(1);
  });

  test("returns a disabled project cache status when the data plane is not configured", async () => {
    projectStatus.mockResolvedValueOnce({
      projectRef: "tenant-a",
      configured: false,
      active: false,
      configurationCurrent: false,
      leases: 0,
      lastUsedAt: null,
    });

    const response = await request("/v1/projects/tenant-a/cache");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectRef: "tenant-a",
      configured: false,
      active: false,
      configurationCurrent: false,
      leases: 0,
      lastUsedAt: null,
    });
  });

  test("maps exact-key operations and keeps projectRef server-derived", async () => {
    const response = await request("/v1/projects/tenant-a/cache/operations", {
      method: "POST",
      body: JSON.stringify({
        op: "set",
        key: "session:one",
        value: { active: true },
        ttl_ms: 2_000,
      }),
    });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith("tenant-a", {
      op: "set",
      key: "session:one",
      value: { active: true },
      ttlMs: 2_000,
    });

    const injectedRef = await request("/v1/projects/tenant-a/cache/operations", {
      method: "POST",
      body: JSON.stringify({ op: "get", key: "one", projectRef: "tenant-b" }),
    });
    expect(injectedRef.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith("tenant-a", { op: "get", key: "one" });
  });

  test("requires an exact project confirmation before flush", async () => {
    const rejected = await request("/v1/projects/tenant-a/cache/flush", {
      method: "POST",
      body: JSON.stringify({ confirmation: "tenant-b" }),
    });
    expect(rejected.status).toBe(400);
    expect(flush).not.toHaveBeenCalled();

    const accepted = await request("/v1/projects/tenant-a/cache/flush", {
      method: "POST",
      body: JSON.stringify({ confirmation: "tenant-a" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ deleted: 3 });
    expect(flush).toHaveBeenCalledWith("tenant-a");
  });

  test("enforces route auth and safe service errors", async () => {
    requireProject.mockResolvedValueOnce({ status: 403, body: { error: "denied" } });
    expect((await request("/v1/projects/tenant-a/cache")).status).toBe(403);
    expect(projectStatus).not.toHaveBeenCalled();

    projectStatus.mockImplementationOnce(() => Promise.reject(
      new AppError("Cache data plane is unavailable", 503, "PGREDIS_RUNTIME_UNAVAILABLE"),
    ));
    const unavailable = await request("/v1/projects/tenant-a/cache");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      message: "Cache data plane is unavailable",
      code: "PGREDIS_RUNTIME_UNAVAILABLE",
    });
  });
});
