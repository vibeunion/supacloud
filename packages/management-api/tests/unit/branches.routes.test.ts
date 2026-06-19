import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const createBranch = mock(() => Promise.resolve(undefined));
const deleteBranch = mock(() => Promise.resolve(undefined));
const promoteBranch = mock(() => Promise.resolve(undefined));

const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");
const branchServiceModule = await import("../../src/services/branch.service");

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(
  updateConfig as typeof projectRepository.updateConfig,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const createBranchSpy = spyOn(branchServiceModule.branchService, "createBranch").mockImplementation(
  createBranch as typeof branchServiceModule.branchService.createBranch,
);
const deleteBranchSpy = spyOn(branchServiceModule.branchService, "deleteBranch").mockImplementation(
  deleteBranch as typeof branchServiceModule.branchService.deleteBranch,
);
const promoteBranchSpy = spyOn(branchServiceModule.branchService, "promoteBranch").mockImplementation(
  promoteBranch as typeof branchServiceModule.branchService.promoteBranch,
);

const { branchRoutes } = await import("../../src/routes/branches");
const { projectRoutes } = await import("../../src/routes/projects");
const app = new Elysia().use(branchRoutes);
const composedApp = new Elysia().use(projectRoutes).use(branchRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
    }),
  );
}

function composedRequest(path: string, init: RequestInit = {}) {
  return composedApp.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
    }),
  );
}

describe("branchRoutes", () => {
  afterAll(() => {
    findByRefSpy.mockRestore();
    updateConfigSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    createBranchSpy.mockRestore();
    deleteBranchSpy.mockRestore();
    promoteBranchSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    createBranch.mockReset();
    deleteBranch.mockReset();
    promoteBranch.mockReset();
    createBranch.mockResolvedValue(undefined);
    deleteBranch.mockResolvedValue(undefined);
    promoteBranch.mockResolvedValue(undefined);
  });

  test("GET returns empty list when no branches", async () => {
    findByRef.mockResolvedValue({ ref: "parent", config: {} } as never);
    const res = await request("/v1/projects/parent/branches");
    expect(res.status).toBe(200);
    expect((await res.json()).branches).toEqual([]);
  });

  test("composed project routes use real branch routes instead of legacy stubs", async () => {
    findByRef.mockResolvedValue({ ref: "parent", config: {} } as never);

    const listRes = await composedRequest("/v1/projects/parent/branches");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ project_ref: "parent", branches: [] });

    const createRes = await composedRequest("/v1/projects/parent/branches", {
      method: "POST",
      body: JSON.stringify({ name: "bad name!" }),
    });
    expect(createRes.status).toBe(400);
  });

  test("POST creates branch record and kicks off provisioning", async () => {
    findByRef.mockResolvedValue({ ref: "parent", config: {} } as never);
    updateConfig.mockImplementation(async (ref, next) => ({ ref, config: next }) as never);

    const res = await request("/v1/projects/parent/branches", {
      method: "POST",
      body: JSON.stringify({ name: "feature-x" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.branch).toMatchObject({ name: "feature-x", parent_ref: "parent", status: "creating" });

    // Wait a tick for the async createBranch promise.
    await new Promise((r) => setTimeout(r, 50));
    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch.mock.calls[0][0]).toMatchObject({ parentRef: "parent", name: "feature-x" });
  });

  test("POST rejects duplicate branch name", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b1", name: "feature-x", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const res = await request("/v1/projects/parent/branches", {
      method: "POST",
      body: JSON.stringify({ name: "feature-x" }),
    });
    expect(res.status).toBe(409);
  });

  test("POST rejects branching from a branch (parent_ref present)", async () => {
    findByRef.mockResolvedValue({
      ref: "b1",
      config: { parent_ref: "parent", is_branch: true },
    } as never);

    const res = await request("/v1/projects/b1/branches", {
      method: "POST",
      body: JSON.stringify({ name: "nested" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects invalid branch name", async () => {
    const res = await request("/v1/projects/parent/branches", {
      method: "POST",
      body: JSON.stringify({ name: "bad name!" }),
    });
    expect(res.status).toBe(400);
  });

  test("DELETE marks branch deleting and invokes service cleanup", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b2", name: "old", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, next) => ({ ref, config: next }) as never);

    const res = await request("/v1/projects/parent/branches/b2", { method: "DELETE" });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(deleteBranch).toHaveBeenCalledWith("b2");
  });

  test("DELETE on unknown branch returns 404", async () => {
    findByRef.mockResolvedValue({ ref: "parent", config: { branches: [] } } as never);
    const res = await request("/v1/projects/parent/branches/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("DELETE keeps metadata and marks error when cleanup fails", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b4", name: "broken", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    updateConfig.mockImplementation(async (ref, next) => ({ ref, config: next }) as never);
    deleteBranch.mockRejectedValue(new Error("DROP DATABASE failed"));

    const res = await request("/v1/projects/parent/branches/b4", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Wait for the async promise chain to settle.
    await new Promise((r) => setTimeout(r, 50));
    // The branch should still exist in metadata (marked as error, not removed).
    const lastCall = updateConfig.mock.calls[updateConfig.mock.calls.length - 1];
    const stored = lastCall[1];
    const storedBranches = (stored as { branches: { ref: string; status: string; error?: string }[] }).branches;
    expect(storedBranches).toHaveLength(1);
    expect(storedBranches[0].ref).toBe("b4");
    expect(storedBranches[0].status).toBe("error");
    expect(storedBranches[0].error).toContain("DROP DATABASE failed");
  });

  test("POST promote calls service.promoteBranch", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const res = await request("/v1/projects/parent/branches/b3/promote", { method: "POST" });
    expect(res.status).toBe(200);
    expect(promoteBranch).toHaveBeenCalledWith({ parentRef: "parent", branchRef: "b3" });
  });
});
