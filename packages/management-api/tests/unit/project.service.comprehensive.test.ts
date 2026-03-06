import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock database to prevent top-level connection attempts
const mockSql: any = mock(() => Promise.resolve([]));
mockSql.unsafe = mock(() => Promise.resolve([]));
mock.module("../../src/db", () => ({
  sql: mockSql,
}));

import { ProjectService, type CreateProjectRequest } from "../../src/services/project.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { jwtService } from "../../src/services/jwt.service";
import { databaseService } from "../../src/services/database.service";
import { storageService } from "../../src/services/storage.service";
import { routerService } from "../../src/services/router.service";
import { shellService } from "../../src/services/shell.service";

describe("ProjectService - Comprehensive", () => {
  let service: ProjectService;

  const mockProject = {
    id: "uuid-test123",
    ref: "test123abc",
    organization_id: "org-default",
    name: "Test Project",
    db_name: "supa_test123abc",
    db_user: "role_test123abc",
    db_password: "password123",
    jwt_secret: "secret123",
    anon_key: "anon.key.test",
    service_role_key: "service.key.test",
    s3_bucket: "supa-test123abc",
    s3_access_key: "access123",
    s3_secret_key: "secret123",
    status: "active" as const,
    region: "local",
    config: { custom: "value" },
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };

  beforeEach(() => {
    service = new ProjectService();
  });

  describe("listProjects", () => {
    test("should return empty array when no projects", async () => {
      const spy = spyOn(projectRepository, "findAll").mockResolvedValue([]);
      const projects = await service.listProjects();
      expect(projects).toEqual([]);
      spy.mockRestore();
    });

    test("should return mapped projects", async () => {
      const spy = spyOn(projectRepository, "findAll").mockResolvedValue([mockProject]);
      const projects = await service.listProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].ref).toBe("test123abc");
      expect(projects[0]).toHaveProperty("database");
      expect(projects[0]).toHaveProperty("api");
      spy.mockRestore();
    });
  });

  describe("getProject", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const project = await service.getProject("nonexistent");
      expect(project).toBeNull();
      spy.mockRestore();
    });

    test("should return project detail response", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const project = await service.getProject("test123abc");
      expect(project).not.toBeNull();
      expect(project?.ref).toBe("test123abc");
      expect(project?.config).toBeDefined();
      expect(project?.updated_at).toBeDefined();
      spy.mockRestore();
    });
  });

  describe("createProject", () => {
    test("should create project with generated credentials", async () => {
      const refSpy = spyOn(jwtService, "generateProjectRef").mockReturnValue("newref1234");
      const passSpy = spyOn(databaseService, "generatePassword").mockReturnValue("dbpassword");
      const keySpy = spyOn(jwtService, "generateKeySet").mockResolvedValue({
        jwtSecret: "jwtsecret",
        anonKey: "anonkey",
        serviceRoleKey: "servicekey",
      });
      const createSpy = spyOn(projectRepository, "create").mockResolvedValue({
        ...mockProject,
        ref: "newref1234",
        name: "New Project",
      });

      const request: CreateProjectRequest = { name: "New Project" };
      const project = await service.createProject(request);

      expect(project.ref).toBe("newref1234");
      expect(project.name).toBe("New Project");

      refSpy.mockRestore();
      passSpy.mockRestore();
      keySpy.mockRestore();
      createSpy.mockRestore();
    });

    test("should accept custom region", async () => {
      const refSpy = spyOn(jwtService, "generateProjectRef").mockReturnValue("newref1234");
      const passSpy = spyOn(databaseService, "generatePassword").mockReturnValue("dbpassword");
      const keySpy = spyOn(jwtService, "generateKeySet").mockResolvedValue({
        jwtSecret: "jwtsecret",
        anonKey: "anonkey",
        serviceRoleKey: "servicekey",
      });
      const createSpy = spyOn(projectRepository, "create").mockResolvedValue({
        ...mockProject,
        ref: "newref1234",
        region: "us-east-1",
      });

      const request: CreateProjectRequest = { name: "US Project", region: "us-east-1" };
      const project = await service.createProject(request);

      expect(project.region).toBe("us-east-1");

      refSpy.mockRestore();
      passSpy.mockRestore();
      keySpy.mockRestore();
      createSpy.mockRestore();
    });
  });

  describe("deleteProject", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.deleteProject("nonexistent");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should soft delete and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const deleteSpy = spyOn(projectRepository, "softDelete").mockResolvedValue(mockProject);

      const result = await service.deleteProject("test123abc");
      expect(result).toBe(true);

      findSpy.mockRestore();
      deleteSpy.mockRestore();
    });
  });

  describe("updateProject", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.updateProject("nonexistent", { name: "New Name" });
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should update name and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const updateSpy = spyOn(projectRepository, "updateConfig").mockResolvedValue(mockProject);

      const result = await service.updateProject("test123abc", { name: "Updated Name" });
      expect(result).toBe(true);

      findSpy.mockRestore();
      updateSpy.mockRestore();
    });

    test("should return true even without name", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);

      const result = await service.updateProject("test123abc", {});
      expect(result).toBe(true);

      findSpy.mockRestore();
    });
  });

  describe("pauseProject", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.pauseProject("nonexistent");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should pause and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const statusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(mockProject);

      const result = await service.pauseProject("test123abc");
      expect(result).toBe(true);

      findSpy.mockRestore();
      statusSpy.mockRestore();
    });
  });

  describe("restoreProject", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.restoreProject("nonexistent");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should restore and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const statusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(mockProject);

      const result = await service.restoreProject("test123abc");
      expect(result).toBe(true);

      findSpy.mockRestore();
      statusSpy.mockRestore();
    });
  });

  describe("getProjectHealth", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getProjectHealth("nonexistent");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return health status for active project", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const dbSpy = spyOn(databaseService, "checkStatus").mockResolvedValue({ success: true, output: "" });

      const result = await service.getProjectHealth("test123abc");
      expect(result).not.toBeNull();
      expect(result?.status).toBe("ACTIVE_HEALTHY");
      expect(result?.services.database).toBe("ACTIVE_HEALTHY");

      findSpy.mockRestore();
      dbSpy.mockRestore();
    });

    test("should return unhealthy when db check fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const dbSpy = spyOn(databaseService, "checkStatus").mockResolvedValue({ success: false, output: "", error: "fail" });

      const result = await service.getProjectHealth("test123abc");
      expect(result?.services.database).toBe("UNHEALTHY");

      findSpy.mockRestore();
      dbSpy.mockRestore();
    });

    test("should return INACTIVE for paused project", async () => {
      const pausedProject = { ...mockProject, status: "paused" as const };
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(pausedProject);
      const dbSpy = spyOn(databaseService, "checkStatus").mockResolvedValue({ success: true, output: "" });

      const result = await service.getProjectHealth("test123abc");
      expect(result?.status).toBe("INACTIVE");

      findSpy.mockRestore();
      dbSpy.mockRestore();
    });
  });

  describe("getProjectStatus", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getProjectStatus("nonexistent");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return status object", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const dbSpy = spyOn(databaseService, "checkStatus").mockResolvedValue({ success: true, output: "" });

      const result = await service.getProjectStatus("test123abc");
      expect(result).not.toBeNull();
      expect(result?.status).toBe("active");
      expect(result?.database).toBe("healthy");

      findSpy.mockRestore();
      dbSpy.mockRestore();
    });

    test("should return unhealthy when db fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const dbSpy = spyOn(databaseService, "checkStatus").mockResolvedValue({ success: false, output: "", error: "fail" });

      const result = await service.getProjectStatus("test123abc");
      expect(result?.database).toBe("unhealthy");

      findSpy.mockRestore();
      dbSpy.mockRestore();
    });
  });

  describe("restartProject", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.restartProject("nonexistent");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should reload router and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const routerSpy = spyOn(routerService, "reload").mockResolvedValue({ success: true });

      const result = await service.restartProject("test123abc");
      expect(result).toBe(true);

      findSpy.mockRestore();
      routerSpy.mockRestore();
    });
  });

  describe("getProjectSettings", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getProjectSettings("nonexistent");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return config object", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);

      const result = await service.getProjectSettings("test123abc");
      expect(result).toEqual({ custom: "value" });

      findSpy.mockRestore();
    });
  });

  describe("updateProjectSettings", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.updateProjectSettings("nonexistent", { key: "value" });
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should merge and update config", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const updatedProject = { ...mockProject, config: { custom: "value", new: "setting" } };
      const updateSpy = spyOn(projectRepository, "updateConfig").mockResolvedValue(updatedProject);

      const result = await service.updateProjectSettings("test123abc", { new: "setting" });
      expect(result).toEqual({ custom: "value", new: "setting" });

      findSpy.mockRestore();
      updateSpy.mockRestore();
    });

    test("should return null when update fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const updateSpy = spyOn(projectRepository, "updateConfig").mockResolvedValue(null);

      const result = await service.updateProjectSettings("test123abc", { new: "setting" });
      expect(result).toBeNull();

      findSpy.mockRestore();
      updateSpy.mockRestore();
    });
  });

  describe("getApiKeys", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getApiKeys("nonexistent");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return api keys", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);

      const result = await service.getApiKeys("test123abc");
      expect(result).not.toBeNull();
      expect(result?.anon_key).toBe("anon.key.test");
      expect(result?.service_role_key).toBe("service.key.test");

      findSpy.mockRestore();
    });
  });

  describe("getSecrets", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getSecrets("nonexistent");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return secrets from database service", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([{ name: "KEY", value: "val" }]);

      const result = await service.getSecrets("test123abc");
      expect(result).toEqual([{ name: "KEY", value: "val" }]);

      findSpy.mockRestore();
      secretsSpy.mockRestore();
    });
  });

  describe("upsertSecrets", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.upsertSecrets("nonexistent", [{ name: "KEY", value: "val" }]);
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should upsert all secrets and return true", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const upsertSpy = spyOn(databaseService, "upsertSecret").mockResolvedValue(true);

      const result = await service.upsertSecrets("test123abc", [
        { name: "KEY1", value: "val1" },
        { name: "KEY2", value: "val2" },
      ]);
      expect(result).toBe(true);

      findSpy.mockRestore();
      upsertSpy.mockRestore();
    });

    test("should return false if any upsert fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const upsertSpy = spyOn(databaseService, "upsertSecret").mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await service.upsertSecrets("test123abc", [
        { name: "KEY1", value: "val1" },
        { name: "KEY2", value: "val2" },
      ]);
      expect(result).toBe(false);

      findSpy.mockRestore();
      upsertSpy.mockRestore();
    });
  });

  describe("deleteSecret", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.deleteSecret("nonexistent", "KEY");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should delete secret and return result", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const deleteSpy = spyOn(databaseService, "deleteSecret").mockResolvedValue(true);

      const result = await service.deleteSecret("test123abc", "KEY");
      expect(result).toBe(true);

      findSpy.mockRestore();
      deleteSpy.mockRestore();
    });
  });

  describe("getFunctionCode", () => {
    test("should return null when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.getFunctionCode("nonexistent", "my-func");
      expect(result).toBeNull();
      spy.mockRestore();
    });

    test("should return code from shell service", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "function code here",
      });

      const result = await service.getFunctionCode("test123abc", "my-func");
      expect(result).toBe("function code here");

      findSpy.mockRestore();
      shellSpy.mockRestore();
    });

    test("should return null when shell fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
        success: false,
        output: "",
        error: "fail",
      });

      const result = await service.getFunctionCode("test123abc", "my-func");
      expect(result).toBeNull();

      findSpy.mockRestore();
      shellSpy.mockRestore();
    });
  });

  describe("deployFunction", () => {
    test("should return false when project not found", async () => {
      const spy = spyOn(projectRepository, "findByRef").mockResolvedValue(null);
      const result = await service.deployFunction("nonexistent", "my-func", "code");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should deploy function and return success", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "deployed",
      });

      const result = await service.deployFunction("test123abc", "my-func", "function code");
      expect(result).toBe(true);

      findSpy.mockRestore();
      shellSpy.mockRestore();
    });

    test("should return false when deploy fails", async () => {
      const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue(mockProject);
      const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
        success: false,
        output: "",
        error: "fail",
      });

      const result = await service.deployFunction("test123abc", "my-func", "code");
      expect(result).toBe(false);

      findSpy.mockRestore();
      shellSpy.mockRestore();
    });
  });
});
