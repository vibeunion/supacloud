import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const baseMock = mock(() => Promise.resolve([]));
(baseMock as unknown as Record<string, unknown>).unsafe = mock(() => Promise.resolve([]));
const actualDb = await import("../../src/db");
const { jwtService } = await import("../../src/services/jwt.service");
const { edgeFunctionService } = await import("../../src/services/edge-function.service");

const jwtServiceMock = {
  generateProjectRef: spyOn(jwtService, "generateProjectRef"),
  generateSecret: spyOn(jwtService, "generateSecret"),
  generateAnonKey: spyOn(jwtService, "generateAnonKey"),
  generateServiceRoleKey: spyOn(jwtService, "generateServiceRoleKey"),
  generateOpaqueKeySet: spyOn(jwtService, "generateOpaqueKeySet"),
  generateKeySet: spyOn(jwtService, "generateKeySet"),
};

const databaseServiceMock = {
  generatePassword: mock(() => "dbpassword"),
  checkDatabaseExists: mock(() => Promise.resolve(true)),
  checkStatus: mock(() => Promise.resolve({ success: true, output: "" })),
  pauseRuntime: mock(() => Promise.resolve({ success: true })),
  resumeRuntime: mock(() => Promise.resolve({ success: true })),
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
  read: spyOn(edgeFunctionService, "read"),
  deploy: spyOn(edgeFunctionService, "deploy"),
  deployDetailed: spyOn(edgeFunctionService, "deployDetailed"),
  deployBundle: spyOn(edgeFunctionService, "deployBundle"),
  deployBundleDetailed: spyOn(edgeFunctionService, "deployBundleDetailed"),
  runtimeCheck: spyOn(edgeFunctionService, "runtimeCheck"),
};

const tenantRuntimeServiceMock = {
  pauseProjectRuntime: mock(() => Promise.resolve()),
  resumeProjectRuntime: mock(() => Promise.resolve({ status: "running" })),
  restartRuntime: mock(() => Promise.resolve({ status: "running" })),
  getProjectServiceStatuses: mock(() => Promise.resolve([
    { id: "storage", name: "storage", status: "ACTIVE_HEALTHY", healthy: true },
  ])),
};

const realtimeServiceMock = {
  updateTenant: mock(() => Promise.resolve()),
};

mock.module("../../src/db", () => ({
  ...actualDb,
  sql: baseMock as unknown,
}));

mock.module("../../src/services/database.service", () => ({
  databaseService: databaseServiceMock,
}));

mock.module("../../src/services/router.service", () => ({
  routerService: routerServiceMock,
}));

mock.module("../../src/services/tenant-runtime.service", () => ({
  tenantRuntimeService: tenantRuntimeServiceMock,
}));

mock.module("../../src/services/realtime.service", () => ({
  realtimeService: realtimeServiceMock,
}));

const { projectRepository } = await import("../../src/repositories/project.repository");
const { taskRepository } = await import("../../src/repositories/task.repository");
const { gatewayService } = await import("../../src/services/gateway.service");

const projectRepositoryMock = {
  findAll: spyOn(projectRepository, "findAll"),
  findByRef: spyOn(projectRepository, "findByRef"),
  create: spyOn(projectRepository, "create"),
  updateStatus: spyOn(projectRepository, "updateStatus"),
  updateConfig: spyOn(projectRepository, "updateConfig"),
  updateApiKeys: spyOn(projectRepository, "updateApiKeys"),
  updateOpaqueApiKeys: spyOn(projectRepository, "updateOpaqueApiKeys"),
  softDelete: spyOn(projectRepository, "softDelete"),
};

const taskRepositoryMock = {
  createTask: spyOn(taskRepository, "createTask"),
};

const gatewayServiceMock = {
  setupUpstream: spyOn(gatewayService, "setupUpstream"),
  setupJwt: spyOn(gatewayService, "setupJwt"),
};

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
    publishable_key: "sb_publishable_previous",
    secret_key_encrypted: "sb_secret_previous",
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
    projectRepositoryMock.updateApiKeys.mockReset();
    projectRepositoryMock.updateOpaqueApiKeys.mockReset();
    projectRepositoryMock.softDelete.mockReset();
    taskRepositoryMock.createTask.mockReset();
    gatewayServiceMock.setupUpstream.mockReset();
    gatewayServiceMock.setupJwt.mockReset();
    jwtServiceMock.generateProjectRef.mockReset();
    jwtServiceMock.generateSecret.mockReset();
    jwtServiceMock.generateAnonKey.mockReset();
    jwtServiceMock.generateServiceRoleKey.mockReset();
    jwtServiceMock.generateOpaqueKeySet.mockReset();
    jwtServiceMock.generateKeySet.mockReset();
    databaseServiceMock.generatePassword.mockReset();
    databaseServiceMock.checkDatabaseExists.mockReset();
    databaseServiceMock.checkStatus.mockReset();
    databaseServiceMock.pauseRuntime.mockReset();
    databaseServiceMock.resumeRuntime.mockReset();
    databaseServiceMock.getSecrets.mockReset();
    databaseServiceMock.upsertSecret.mockReset();
    databaseServiceMock.deleteSecret.mockReset();
    routerServiceMock.getProjectDomain.mockReset();
    routerServiceMock.getProjectApiUrl.mockReset();
    routerServiceMock.getProjectStudioUrl.mockReset();
    routerServiceMock.reload.mockReset();
    edgeFunctionServiceMock.read.mockReset();
    edgeFunctionServiceMock.deploy.mockReset();
    edgeFunctionServiceMock.deployDetailed.mockReset();
    edgeFunctionServiceMock.deployBundle.mockReset();
    edgeFunctionServiceMock.deployBundleDetailed.mockReset();
    edgeFunctionServiceMock.runtimeCheck.mockReset();
    tenantRuntimeServiceMock.pauseProjectRuntime.mockReset();
    tenantRuntimeServiceMock.resumeProjectRuntime.mockReset();
    tenantRuntimeServiceMock.restartRuntime.mockReset();
    realtimeServiceMock.updateTenant.mockReset();

    projectRepositoryMock.findAll.mockResolvedValue([]);
    projectRepositoryMock.findByRef.mockResolvedValue(null);
    projectRepositoryMock.create.mockResolvedValue(mockProject);
    projectRepositoryMock.updateStatus.mockResolvedValue(mockProject);
    projectRepositoryMock.updateConfig.mockResolvedValue(mockProject);
    projectRepositoryMock.updateApiKeys.mockResolvedValue(mockProject);
    projectRepositoryMock.updateOpaqueApiKeys.mockResolvedValue(mockProject);
    projectRepositoryMock.softDelete.mockResolvedValue(mockProject);
    taskRepositoryMock.createTask.mockResolvedValue({ id: "tsk_1" });
    gatewayServiceMock.setupUpstream.mockResolvedValue({ success: true });
    gatewayServiceMock.setupJwt.mockResolvedValue({ success: true });
    jwtServiceMock.generateProjectRef.mockReturnValue("newref1234");
    jwtServiceMock.generateSecret.mockReturnValue("rotated-jwt-secret");
    jwtServiceMock.generateAnonKey.mockResolvedValue("rotated-anon-key");
    jwtServiceMock.generateServiceRoleKey.mockResolvedValue("rotated-service-key");
    jwtServiceMock.generateOpaqueKeySet.mockReturnValue({
      publishableKey: "sb_publishable_rotated",
      secretKey: "sb_secret_rotated",
    });
    jwtServiceMock.generateKeySet.mockResolvedValue({
      jwtSecret: "jwtsecret",
      anonKey: "anonkey",
      serviceRoleKey: "servicekey",
    });
    databaseServiceMock.generatePassword.mockReturnValue("dbpassword");
    databaseServiceMock.checkDatabaseExists.mockResolvedValue(true);
    databaseServiceMock.checkStatus.mockResolvedValue({ success: true, output: "" });
    databaseServiceMock.pauseRuntime.mockResolvedValue({ success: true });
    databaseServiceMock.resumeRuntime.mockResolvedValue({ success: true });
    databaseServiceMock.getSecrets.mockResolvedValue([{ name: "KEY", value: "val" }]);
    databaseServiceMock.upsertSecret.mockResolvedValue(true);
    databaseServiceMock.deleteSecret.mockResolvedValue(true);
    routerServiceMock.getProjectDomain.mockImplementation((ref: string) => `${ref}.localhost`);
    routerServiceMock.getProjectApiUrl.mockImplementation((ref: string) => `https://${ref}.api.localhost`);
    routerServiceMock.getProjectStudioUrl.mockImplementation((ref: string) => `https://${ref}.studio.localhost`);
    routerServiceMock.reload.mockResolvedValue({ success: true });
    edgeFunctionServiceMock.read.mockResolvedValue("function code here");
    edgeFunctionServiceMock.deploy.mockResolvedValue(true);
    edgeFunctionServiceMock.deployDetailed.mockResolvedValue({
      success: true,
      version: "1",
      bundled: true,
    });
    edgeFunctionServiceMock.deployBundle.mockResolvedValue(true);
    edgeFunctionServiceMock.deployBundleDetailed.mockResolvedValue({
      success: true,
      version: "2",
      bundled: true,
      files: 2,
      import_map: null,
    });
    edgeFunctionServiceMock.runtimeCheck.mockResolvedValue({
      runtime_url: "http://127.0.0.1:9000",
      active_version: "2",
      active_artifact_path: "/tmp/index.js",
      artifact_exists: true,
      runtime_healthy: true,
      preheat_ok: true,
    });
    tenantRuntimeServiceMock.pauseProjectRuntime.mockResolvedValue(undefined);
    tenantRuntimeServiceMock.resumeProjectRuntime.mockResolvedValue({ status: "running" });
    tenantRuntimeServiceMock.restartRuntime.mockResolvedValue({ status: "running" });
    realtimeServiceMock.updateTenant.mockResolvedValue(undefined);
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
    expect(databaseServiceMock.pauseRuntime).toHaveBeenCalledWith("test123abc");
  });

  test("restoreProject updates status", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    expect(await service.restoreProject("test123abc")).toBe(true);
    expect(databaseServiceMock.checkDatabaseExists).toHaveBeenCalledWith("test123abc");
    expect(projectRepositoryMock.updateStatus).toHaveBeenCalledWith("test123abc", "active");
    expect(databaseServiceMock.resumeRuntime).toHaveBeenCalledWith("test123abc");
  });

  test("restoreProject re-provisions resources when tenant database is missing", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    databaseServiceMock.checkDatabaseExists.mockResolvedValueOnce(false);

    expect(await service.restoreProject("test123abc")).toBe(true);

    expect(projectRepositoryMock.updateStatus).not.toHaveBeenCalledWith("test123abc", "active");
    expect(taskRepositoryMock.createTask).toHaveBeenCalledWith("test123abc", "provision_db", {
      dbPassword: "password123",
      domain: undefined,
    });
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

  test("restartProject reconciles gateway routes when tenant ports are known", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce({
      ...mockProject,
      config: {
        postgrest_port: 3234,
        gotrue_port: 4234,
        custom_domain: "xg.aizhuliren.cn",
        api_domain: "api.xg.aizhuliren.cn",
        studio_domain: "studio.xg.aizhuliren.cn",
      },
    });

    const result = await service.restartProject("test123abc");

    expect(result).toBe(true);
    expect(gatewayServiceMock.setupUpstream).toHaveBeenCalledWith(
      "test123abc",
      3234,
      4234,
      {
        postgrest_port: 3234,
        gotrue_port: 4234,
        custom_domain: "xg.aizhuliren.cn",
        api_domain: "api.xg.aizhuliren.cn",
        studio_domain: "studio.xg.aizhuliren.cn",
      },
    );
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

  test("updateProjectSettings restarts runtime when routing settings change", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    projectRepositoryMock.updateConfig.mockResolvedValueOnce({
      ...mockProject,
      config: { custom: "value", api_domain: "xgapi.aizhuliren.cn" },
    });

    const result = await service.updateProjectSettings("test123abc", {
      api_domain: "xgapi.aizhuliren.cn",
    });

    expect(result).toEqual({
      custom: "value",
      api_domain: "xgapi.aizhuliren.cn",
    });
    expect(tenantRuntimeServiceMock.restartRuntime).toHaveBeenCalledWith("test123abc");
  });

  test("updateProjectSettings reconciles gateway routes for custom domain changes", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce({
      ...mockProject,
      config: {
        postgrest_port: 3234,
        gotrue_port: 4234,
        custom_domain: "old.example.com",
      },
    });
    projectRepositoryMock.updateConfig.mockResolvedValueOnce({
      ...mockProject,
      config: {
        postgrest_port: 3234,
        gotrue_port: 4234,
        custom_domain: "xg.aizhuliren.cn",
        api_domain: "api.xg.aizhuliren.cn",
        studio_domain: "studio.xg.aizhuliren.cn",
      },
    });

    const result = await service.updateProjectSettings("test123abc", {
      custom_domain: "xg.aizhuliren.cn",
      api_domain: "api.xg.aizhuliren.cn",
      studio_domain: "studio.xg.aizhuliren.cn",
    });

    expect(result).toEqual({
      postgrest_port: 3234,
      gotrue_port: 4234,
      custom_domain: "xg.aizhuliren.cn",
      api_domain: "api.xg.aizhuliren.cn",
      studio_domain: "studio.xg.aizhuliren.cn",
    });
    expect(gatewayServiceMock.setupUpstream).toHaveBeenCalledWith(
      "test123abc",
      3234,
      4234,
      {
        postgrest_port: 3234,
        gotrue_port: 4234,
        custom_domain: "xg.aizhuliren.cn",
        api_domain: "api.xg.aizhuliren.cn",
        studio_domain: "studio.xg.aizhuliren.cn",
      },
    );
  });

  test("updateProjectSettings reconciles gateway routes for additional API domain changes", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce({
      ...mockProject,
      config: {
        postgrest_port: 3260,
        gotrue_port: 3360,
        api_domain: "api.xgic-ingest.192.168.1.48.sslip.io",
      },
    });
    projectRepositoryMock.updateConfig.mockResolvedValueOnce({
      ...mockProject,
      config: {
        postgrest_port: 3260,
        gotrue_port: 3360,
        api_domain: "api.xgic-ingest.192.168.1.48.sslip.io",
        additional_api_domains: [
          "ingest-api.ai.xigu.team",
          "api.xgic-ingest.ai.xigu.team",
        ],
      },
    });

    const result = await service.updateProjectSettings("test123abc", {
      additional_api_domains: [
        "ingest-api.ai.xigu.team",
        "api.xgic-ingest.ai.xigu.team",
      ],
    });

    expect(result).toEqual({
      postgrest_port: 3260,
      gotrue_port: 3360,
      api_domain: "api.xgic-ingest.192.168.1.48.sslip.io",
      additional_api_domains: [
        "ingest-api.ai.xigu.team",
        "api.xgic-ingest.ai.xigu.team",
      ],
    });
    expect(tenantRuntimeServiceMock.restartRuntime).toHaveBeenCalledWith("test123abc");
    expect(gatewayServiceMock.setupUpstream).toHaveBeenCalledWith(
      "test123abc",
      3260,
      3360,
      {
        postgrest_port: 3260,
        gotrue_port: 3360,
        api_domain: "api.xgic-ingest.192.168.1.48.sslip.io",
        additional_api_domains: [
          "ingest-api.ai.xigu.team",
          "api.xgic-ingest.ai.xigu.team",
        ],
      },
    );
  });

  test("getApiKeys returns api keys", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.getApiKeys("test123abc");
    expect(result?.anon_key).toBe("anon.key.test");
    expect(result?.service_role_key).toBe("service.key.test");
  });

  test("rotateApiKeys preserves opaque keys and rotates legacy JWT state", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);

    const result = await service.rotateApiKeys("test123abc");

    expect(result).toEqual({
      anon_key: "rotated-anon-key",
      service_role_key: "rotated-service-key",
    });
    expect(projectRepositoryMock.updateApiKeys).toHaveBeenCalledWith("test123abc", {
      jwt_secret: "rotated-jwt-secret",
      anon_key: "rotated-anon-key",
      service_role_key: "rotated-service-key",
    });
    expect(projectRepositoryMock.updateOpaqueApiKeys).not.toHaveBeenCalled();
    expect(jwtServiceMock.generateOpaqueKeySet).not.toHaveBeenCalled();
    expect(tenantRuntimeServiceMock.restartRuntime).toHaveBeenCalledWith("test123abc");
  });

  test("rotateOpaqueApiKeys does not invalidate legacy JWT sessions", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);

    const result = await service.rotateOpaqueApiKeys("test123abc");

    expect(result).toEqual({
      publishable_key: "sb_publishable_rotated",
      secret_key: "sb_secret_rotated",
    });
    expect(projectRepositoryMock.updateOpaqueApiKeys).toHaveBeenCalledWith("test123abc", {
      publishable_key: "sb_publishable_rotated",
      secret_key: "sb_secret_rotated",
    });
    expect(projectRepositoryMock.updateApiKeys).not.toHaveBeenCalled();
    expect(gatewayServiceMock.setupJwt).not.toHaveBeenCalled();
    expect(realtimeServiceMock.updateTenant).not.toHaveBeenCalled();
    expect(tenantRuntimeServiceMock.restartRuntime).not.toHaveBeenCalled();
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

  test("upsertSecrets returns true only after written names are readable", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    databaseServiceMock.upsertSecret.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    databaseServiceMock.getSecrets.mockResolvedValueOnce([
      { name: "KEY1", value: "val1" },
      { name: "KEY2", value: "val2" },
    ]);

    const result = await service.upsertSecrets("test123abc", [
      { name: "KEY1", value: "val1" },
      { name: "KEY2", value: "val2" },
    ]);

    expect(result).toBe(true);
    expect(databaseServiceMock.getSecrets).toHaveBeenCalledWith("test123abc");
  });

  test("upsertSecrets returns false when write reports success but secrets remain invisible", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    databaseServiceMock.upsertSecret.mockResolvedValueOnce(true);
    databaseServiceMock.getSecrets.mockResolvedValueOnce([]);

    const result = await service.upsertSecrets("test123abc", [
      { name: "DATA_ORGANIZATION_API_TOKEN", value: "token" },
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

  test("deployFunctionBundleDetailed returns edge function deploy details", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.deployFunctionBundleDetailed(
      "test123abc",
      "my-func",
      { "index.ts": "export default () => new Response('ok')" },
      "index.ts",
      false,
    );
    expect(result).toMatchObject({
      success: true,
      version: "2",
      bundled: true,
    });
    expect(edgeFunctionServiceMock.deployBundleDetailed).toHaveBeenCalled();
  });

  test("checkFunctionRuntime proxies runtime check details", async () => {
    projectRepositoryMock.findByRef.mockResolvedValueOnce(mockProject);
    const result = await service.checkFunctionRuntime("test123abc", "my-func");
    expect(result).toMatchObject({
      runtime_url: "http://127.0.0.1:9000",
      active_version: "2",
      preheat_ok: true,
    });
    expect(edgeFunctionServiceMock.runtimeCheck).toHaveBeenCalledWith(
      "test123abc",
      "my-func",
    );
  });
});

afterAll(() => {
  mock.restore();
});
