import { beforeEach, describe, expect, mock, test } from "bun:test";

const baseMock = mock(() => Promise.resolve([]));
(baseMock as unknown as Record<string, unknown>).unsafe = mock(() => Promise.resolve([]));
const actualDb = await import("../../src/db");

const projectRepositoryMock = {
  findAll: mock(() => Promise.resolve([])),
  findByRef: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve(null)),
  updateStatus: mock(() => Promise.resolve(null)),
  updateConfig: mock(() => Promise.resolve(null)),
  softDelete: mock(() => Promise.resolve(null)),
};

const taskRepositoryMock = {
  createTask: mock(() => Promise.resolve({ id: "tsk_1" })),
};

const jwtServiceMock = {
  generateProjectRef: mock(() => "newref1234"),
  generateKeySet: mock(() =>
    Promise.resolve({
      jwtSecret: "jwtsecret",
      anonKey: "anonkey",
      serviceRoleKey: "servicekey",
    }),
  ),
};

const databaseServiceMock = {
  generatePassword: mock(() => "dbpassword"),
  checkStatus: mock(() => Promise.resolve({ success: true, output: "" })),
  getSecrets: mock(() => Promise.resolve([{ name: "KEY", value: "val" }])),
  upsertSecret: mock(() => Promise.resolve(true)),
  deleteSecret: mock(() => Promise.resolve(true)),
};

const routerServiceMock = {
  getProjectDomain: mock((ref: string) => `${ref}.localhost`),
  getProjectApiUrl: mock((ref: string) => `https://${ref}.api.localhost`),
  getProjectStudioUrl: mock((ref: string) => `https://${ref}.studio.localhost`),
  reload: mock(() => Promise.resolve({ success: true })),
};

const edgeFunctionServiceMock = {
  read: mock(() => Promise.resolve("function code here")),
  deploy: mock(() => Promise.resolve(true)),
};

mock.module("../../src/db", () => ({
  ...actualDb,
  sql: baseMock as unknown,
}));

mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: projectRepositoryMock,
}));

mock.module("../../src/repositories/task.repository", () => ({
  taskRepository: taskRepositoryMock,
}));

mock.module("../../src/services/jwt.service", () => ({
  jwtService: jwtServiceMock,
}));

mock.module("../../src/services/database.service", () => ({
  databaseService: databaseServiceMock,
}));

mock.module("../../src/services/router.service", () => ({
  routerService: routerServiceMock,
}));

mock.module("../../src/services/edge-function.service", () => ({
  edgeFunctionService: edgeFunctionServiceMock,
}));

const { ProjectService } = await import("../../src/services/project.service");

describe("ProjectService - Comprehensive", () => {
  let service: InstanceType<typeof ProjectService>;

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

    projectRepositoryMock.findAll.mockReset();
    projectRepositoryMock.findByRef.mockReset();
    projectRepositoryMock.create.mockReset();
    projectRepositoryMock.updateStatus.mockReset();
    projectRepositoryMock.updateConfig.mockReset();
    projectRepositoryMock.softDelete.mockReset();
    taskRepositoryMock.createTask.mockReset();
    jwtServiceMock.generateProjectRef.mockReset();
    jwtServiceMock.generateKeySet.mockReset();
    databaseServiceMock.generatePassword.mockReset();
    databaseServiceMock.checkStatus.mockReset();
    databaseServiceMock.getSecrets.mockReset();
    databaseServiceMock.upsertSecret.mockReset();
    databaseServiceMock.deleteSecret.mockReset();
    routerServiceMock.getProjectDomain.mockReset();
    routerServiceMock.getProjectApiUrl.mockReset();
    routerServiceMock.getProjectStudioUrl.mockReset();
    routerServiceMock.reload.mockReset();
    edgeFunctionServiceMock.read.mockReset();
    edgeFunctionServiceMock.deploy.mockReset();

    projectRepositoryMock.findAll.mockResolvedValue([]);
    projectRepositoryMock.findByRef.mockResolvedValue(null);
    projectRepositoryMock.create.mockResolvedValue(mockProject);
    projectRepositoryMock.updateStatus.mockResolvedValue(mockProject);
    projectRepositoryMock.updateConfig.mockResolvedValue(mockProject);
    projectRepositoryMock.softDelete.mockResolvedValue(mockProject);
    taskRepositoryMock.createTask.mockResolvedValue({ id: "tsk_1" });
    jwtServiceMock.generateProjectRef.mockReturnValue("newref1234");
    jwtServiceMock.generateKeySet.mockResolvedValue({
      jwtSecret: "jwtsecret",
      anonKey: "anonkey",
      serviceRoleKey: "servicekey",
    });
    databaseServiceMock.generatePassword.mockReturnValue("dbpassword");
    databaseServiceMock.checkStatus.mockResolvedValue({ success: true, output: "" });
    databaseServiceMock.getSecrets.mockResolvedValue([{ name: "KEY", value: "val" }]);
    databaseServiceMock.upsertSecret.mockResolvedValue(true);
    databaseServiceMock.deleteSecret.mockResolvedValue(true);
    routerServiceMock.getProjectDomain.mockImplementation((ref: string) => `${ref}.localhost`);
    routerServiceMock.getProjectApiUrl.mockImplementation((ref: string) => `https://${ref}.api.localhost`);
    routerServiceMock.getProjectStudioUrl.mockImplementation((ref: string) => `https://${ref}.studio.localhost`);
    routerServiceMock.reload.mockResolvedValue({ success: true });
    edgeFunctionServiceMock.read.mockResolvedValue("function code here");
    edgeFunctionServiceMock.deploy.mockResolvedValue(true);
  });

  test("listProjects returns empty array when no projects", async () => {
    projectRepositoryMock.findAll.mockResolvedValueOnce([]);
    const projects = await service.listProjects();
    expect(projects).toEqual([]);
  });

  test("listProjects returns mapped projects", async () => {
    projectRepositoryMock.findAll.mockResolvedValueOnce([mockProject]);
    const projects = await service.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].ref).toBe("test123abc");
    expect(projects[0]).toHaveProperty("database");
    expect(projects[0]).toHaveProperty("api");
  });

  test("getProject returns null when project not found", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(null);
    expect(await service.getProject("missing")).toBeNull();
  });

  test("getProject returns mapped detail response", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const project = await service.getProject("test123abc");
    expect(project?.ref).toBe("test123abc");
    expect(project?.config).toEqual({ custom: "value" });
  });

  test("createProject creates project with generated credentials", async () => {
    projectRepositoryMock.create.mockResolvedValueOnce({
      ...mockProject,
      ref: "newref1234",
      name: "New Project",
    });

    const project = await service.createProject({ name: "New Project" });
    expect(project.ref).toBe("newref1234");
    expect(project.name).toBe("New Project");
    expect(projectRepositoryMock.create).toHaveBeenCalled();
    expect(taskRepositoryMock.createTask).toHaveBeenCalledWith("newref1234", "provision_db", {
      dbPassword: "dbpassword",
      domain: undefined,
    });
  });

  test("createProject accepts custom region", async () => {
    projectRepositoryMock.create.mockResolvedValueOnce({
      ...mockProject,
      ref: "newref1234",
      region: "us-east-1",
    });

    const project = await service.createProject({ name: "US Project", region: "us-east-1" });
    expect(project.region).toBe("us-east-1");
  });

  test("deleteProject returns false when project not found", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(null);
    expect(await service.deleteProject("missing")).toBe(false);
  });

  test("deleteProject soft deletes and queues cleanup", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.deleteProject("test123abc")).toBe(true);
    expect(projectRepositoryMock.softDelete).toHaveBeenCalledWith("test123abc");
    expect(taskRepositoryMock.createTask).toHaveBeenCalledWith("test123abc", "cleanup_runtime");
  });

  test("updateProject returns false when project not found", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(null);
    expect(await service.updateProject("missing", { name: "New Name" })).toBe(false);
  });

  test("updateProject updates display_name when name is provided", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.updateProject("test123abc", { name: "Updated Name" })).toBe(true);
    expect(projectRepositoryMock.updateConfig).toHaveBeenCalledWith("test123abc", {
      ...mockProject.config,
      display_name: "Updated Name",
    });
  });

  test("pauseProject updates status", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.pauseProject("test123abc")).toBe(true);
    expect(projectRepositoryMock.updateStatus).toHaveBeenCalledWith("test123abc", "paused");
  });

  test("restoreProject updates status", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.restoreProject("test123abc")).toBe(true);
    expect(projectRepositoryMock.updateStatus).toHaveBeenCalledWith("test123abc", "active");
  });

  test("getProjectHealth returns null when project not found", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(null);
    expect(await service.getProjectHealth("missing")).toBeNull();
  });

  test("getProjectStatus returns status object", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.getProjectStatus("test123abc");
    expect(result?.status).toBe("active");
    expect(result?.database).toBe("healthy");
  });

  test("restartProject reloads runtime", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.restartProject("test123abc");
    expect(result).toBe(true);
  });

  test("getProjectSettings returns config", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.getProjectSettings("test123abc")).toEqual({ custom: "value" });
  });

  test("updateProjectSettings merges config", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    projectRepositoryMock.updateConfig.mockResolvedValueOnce({
      ...mockProject,
      config: { custom: "value", new: "setting" },
    });
    expect(await service.updateProjectSettings("test123abc", { new: "setting" })).toEqual({
      custom: "value",
      new: "setting",
    });
  });

  test("getApiKeys returns api keys", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.getApiKeys("test123abc");
    expect(result?.anon_key).toBe("anon.key.test");
    expect(result?.service_role_key).toBe("service.key.test");
  });

  test("getSecrets delegates to database service", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.getSecrets("test123abc")).toEqual([{ name: "KEY", value: "val" }]);
  });

  test("upsertSecrets returns false when one write fails", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    databaseServiceMock.upsertSecret.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await service.upsertSecrets("test123abc", [
      { name: "KEY1", value: "val1" },
      { name: "KEY2", value: "val2" },
    ]);
    expect(result).toBe(false);
  });

  test("deleteSecret delegates to database service", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.deleteSecret("test123abc", "KEY")).toBe(true);
  });

  test("getFunctionCode delegates to edge function service", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.getFunctionCode("test123abc", "my-func")).toBe("function code here");
  });

  test("deployFunction delegates to edge function service", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.deployFunction("test123abc", "my-func", "code")).toBe(true);
  });
});
