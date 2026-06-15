import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { branchService } from "../../src/services/branch.service";
import { databaseService } from "../../src/services/database.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { projectRepository } from "../../src/repositories/project.repository";

describe("branchService", () => {
  afterEach(() => {
    // bun:test restores spies individually; keep cleanup explicit for this service-level test.
  });

  test("createBranch restores into an empty database instead of pre-applying the tenant schema", async () => {
    const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      ref: "parent",
      name: "Parent Project",
      db_password: "parent-password",
      jwt_secret: "jwt-secret",
      anon_key: "anon-key",
      service_role_key: "service-role-key",
      region: "local",
      config: {},
    } as never);
    const createProjectSpy = spyOn(projectRepository, "create").mockResolvedValue({ ref: "branch" } as never);
    const createDatabaseSpy = spyOn(databaseService, "createDatabase").mockResolvedValue({ success: true });
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue({ success: true } as never);

    const createEmptySpy = spyOn(branchService as unknown as { createEmptyTenantDatabase: () => Promise<void> }, "createEmptyTenantDatabase").mockResolvedValue(undefined);
    const cloneSpy = spyOn(branchService as unknown as { cloneDatabase: () => Promise<void> }, "cloneDatabase").mockResolvedValue(undefined);
    const grantsSpy = spyOn(branchService as unknown as { applyRuntimeGrants: () => Promise<void> }, "applyRuntimeGrants").mockResolvedValue(undefined);

    try {
      await branchService.createBranch({ parentRef: "parent", branchRef: "branch", name: "feature-x" });

      expect(createProjectSpy).toHaveBeenCalledTimes(1);
      expect(createEmptySpy).toHaveBeenCalledTimes(1);
      expect(cloneSpy).toHaveBeenCalledWith("supa_parent", "supa_branch");
      expect(grantsSpy).toHaveBeenCalledTimes(1);
      expect(createDatabaseSpy).not.toHaveBeenCalled();
      expect(restartSpy).toHaveBeenCalledWith("branch");
    } finally {
      findSpy.mockRestore();
      createProjectSpy.mockRestore();
      createDatabaseSpy.mockRestore();
      restartSpy.mockRestore();
      createEmptySpy.mockRestore();
      cloneSpy.mockRestore();
      grantsSpy.mockRestore();
    }
  });
});
