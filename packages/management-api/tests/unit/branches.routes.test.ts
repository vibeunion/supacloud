import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const findByRef = mock(() => Promise.resolve(null));
const updateConfig = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const requireAdminAuth = mock(() => Promise.resolve(null));
const createBranch = mock(() => Promise.resolve(undefined));
const deleteBranch = mock(() => Promise.resolve(undefined));
const promotionPlan = {
  mode: "migrations" as const,
  parent_ref: "parent",
  branch_ref: "b3",
  safe_to_apply: true,
  plan_checksum: "a".repeat(64),
  pending: [],
  applied: [],
  blocked: [],
  warnings: [],
  requires_destructive_confirmation: false,
  ignored_branch_data: true,
};
const planBranchPromotion = mock(() => Promise.resolve(promotionPlan));
const promoteBranch = mock(() => Promise.resolve({ applied: [], plan: promotionPlan }));
const replaceParentDatabaseFromBranch = mock(() => Promise.resolve({ backupDatabase: "supa_parent_backup" }));

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
const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const createBranchSpy = spyOn(branchServiceModule.branchService, "createBranch").mockImplementation(
  createBranch as typeof branchServiceModule.branchService.createBranch,
);
const deleteBranchSpy = spyOn(branchServiceModule.branchService, "deleteBranch").mockImplementation(
  deleteBranch as typeof branchServiceModule.branchService.deleteBranch,
);
const planBranchPromotionSpy = spyOn(branchServiceModule.branchService, "planBranchPromotion").mockImplementation(
  planBranchPromotion as typeof branchServiceModule.branchService.planBranchPromotion,
);
const promoteBranchSpy = spyOn(branchServiceModule.branchService, "promoteBranch").mockImplementation(
  promoteBranch as typeof branchServiceModule.branchService.promoteBranch,
);
const replaceParentDatabaseFromBranchSpy = spyOn(branchServiceModule.branchService, "replaceParentDatabaseFromBranch").mockImplementation(
  replaceParentDatabaseFromBranch as typeof branchServiceModule.branchService.replaceParentDatabaseFromBranch,
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
    requireAdminAuthSpy.mockRestore();
    createBranchSpy.mockRestore();
    deleteBranchSpy.mockRestore();
    planBranchPromotionSpy.mockRestore();
    promoteBranchSpy.mockRestore();
    replaceParentDatabaseFromBranchSpy.mockRestore();
  });

  beforeEach(() => {
    findByRef.mockReset();
    updateConfig.mockReset();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(null);
    createBranch.mockReset();
    deleteBranch.mockReset();
    planBranchPromotion.mockReset();
    promoteBranch.mockReset();
    replaceParentDatabaseFromBranch.mockReset();
    createBranch.mockResolvedValue(undefined);
    deleteBranch.mockResolvedValue(undefined);
    planBranchPromotion.mockResolvedValue(promotionPlan);
    promoteBranch.mockResolvedValue({ applied: [], plan: promotionPlan });
    replaceParentDatabaseFromBranch.mockResolvedValue({ backupDatabase: "supa_parent_backup" });
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
    expect(createBranch.mock.calls[0][0]).toMatchObject({
      parentRef: "parent",
      name: "feature-x",
      dataMode: "schema_only",
    });
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

  test("POST keeps full data cloning explicit", async () => {
    findByRef.mockResolvedValue({ ref: "parent", config: {} } as never);
    updateConfig.mockImplementation(async (ref, next) => ({ ref, config: next }) as never);

    const res = await request("/v1/projects/parent/branches", {
      method: "POST",
      body: JSON.stringify({ name: "debug-data", data_mode: "full_clone" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).branch.data_mode).toBe("full_clone");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createBranch).toHaveBeenCalledWith(expect.objectContaining({ dataMode: "full_clone" }));
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

  test("GET promote plan returns controlled pending migrations", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const res = await request("/v1/projects/parent/branches/b3/promote/plan");
    expect(res.status).toBe(200);
    expect(planBranchPromotion).toHaveBeenCalledWith({ parentRef: "parent", branchRef: "b3" });
    expect((await res.json()).ignored_branch_data).toBe(true);
  });

  test("POST promote requires a reviewed plan checksum", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "migrations" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("promotion_plan_required");
    expect(promoteBranch).not.toHaveBeenCalled();
  });

  test("POST promote applies only reviewed migrations", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const checksum = "a".repeat(64);
    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "migrations", plan_checksum: checksum, confirm_destructive: true }),
    });
    expect(res.status).toBe(200);
    expect(promoteBranch).toHaveBeenCalledWith({
      parentRef: "parent",
      branchRef: "b3",
      expectedPlanChecksum: checksum,
      confirmDestructive: true,
    });
    expect(replaceParentDatabaseFromBranch).not.toHaveBeenCalled();
  });

  test("POST promote preserves partial application evidence", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    const applied = [{
      version: "202607180001",
      name: "one",
      checksum: "b".repeat(64),
      statement_count: 1,
      statements: ["select 1"],
      destructive: false,
    }];
    promoteBranch.mockRejectedValue(new branchServiceModule.BranchPromotionError(
      "promotion_readback_failed",
      500,
      "read-back failed",
      promotionPlan,
      applied,
    ));

    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "migrations", plan_checksum: "a".repeat(64) }),
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ code: "promotion_readback_failed", applied });
  });

  test("whole-database replacement requires admin auth and exact confirmation", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);

    const denied = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "replace_database", confirmation: "yes" }),
    });
    expect(denied.status).toBe(400);
    expect(replaceParentDatabaseFromBranch).not.toHaveBeenCalled();

    const confirmation = "REPLACE parent WITH b3";
    const allowed = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "replace_database", confirmation }),
    });
    expect(allowed.status).toBe(200);
    expect(requireAdminAuth).toHaveBeenCalled();
    expect(replaceParentDatabaseFromBranch).toHaveBeenCalledWith({ parentRef: "parent", branchRef: "b3" });
  });

  test("whole-database replacement rejects project credentials without admin authority", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    requireAdminAuth.mockResolvedValue({ status: 403, body: { error: "Admin token required" } });

    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "replace_database", confirmation: "REPLACE parent WITH b3" }),
    });

    expect(res.status).toBe(403);
    expect(replaceParentDatabaseFromBranch).not.toHaveBeenCalled();
  });

  test("replacement runtime failure returns committed state and backup evidence", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    replaceParentDatabaseFromBranch.mockRejectedValue(
      new branchServiceModule.BranchReplacementError(
        "replacement_runtime_unavailable",
        503,
        "Database replacement committed, but runtime is unhealthy",
        true,
        "supa_parent_backup_1",
      ),
    );

    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "replace_database", confirmation: "REPLACE parent WITH b3" }),
    });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      code: "replacement_runtime_unavailable",
      replacement_committed: true,
      backup_database: "supa_parent_backup_1",
      recovery_required: true,
    });
  });

  test("replacement rollback failure returns manual recovery state without claiming commit", async () => {
    findByRef.mockResolvedValue({
      ref: "parent",
      config: {
        branches: [{ ref: "b3", name: "ready", parent_ref: "parent", status: "active", created_at: "" }],
      },
    } as never);
    replaceParentDatabaseFromBranch.mockRejectedValue(
      new branchServiceModule.BranchReplacementError(
        "replacement_switch_failed",
        500,
        "Replacement failed and rollback could not be verified",
        false,
        "supa_parent_backup_1",
        true,
        "supa_parent_backup_1",
      ),
    );

    const res = await request("/v1/projects/parent/branches/b3/promote", {
      method: "POST",
      body: JSON.stringify({ mode: "replace_database", confirmation: "REPLACE parent WITH b3" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      replacement_committed: false,
      recovery_required: true,
      backup_database: "supa_parent_backup_1",
      recovery_database: "supa_parent_backup_1",
    });
  });
});
