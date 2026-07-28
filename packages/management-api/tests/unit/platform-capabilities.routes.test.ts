import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const getProject = mock(() => Promise.resolve(null));
const listBackups = mock(() => Promise.resolve([]));
const resolveDbName = mock((ref: string) => Promise.resolve(`supa_${ref}`));
const getUpgradeStatus = mock(() => Promise.resolve({
  status: "available",
  capability: true,
  available: true,
  scope: "cluster",
  current_version: "15",
  target_version: null,
  upgrade_status: "not_started",
}));
const requestUpgrade = mock(() => Promise.resolve({ id: "upgrade-1", status: "awaiting_approval", scope: "cluster" }));

const authModule = await import("../../src/middleware/auth");
const servicesModule = await import("../../src/services");
const backupModule = await import("../../src/services/backup.service");
const dbModule = await import("../../src/db");
const upgradeModule = await import("../../src/services/postgres-major-upgrade.service");

const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const getProjectSpy = spyOn(servicesModule.projectService, "getProject").mockImplementation(
  getProject as typeof servicesModule.projectService.getProject,
);
const listBackupsSpy = spyOn(backupModule, "listBackups").mockImplementation(
  listBackups as typeof backupModule.listBackups,
);
const resolveDbNameSpy = spyOn(dbModule, "resolveDbName").mockImplementation(
  resolveDbName as typeof dbModule.resolveDbName,
);
const getUpgradeStatusSpy = spyOn(upgradeModule.postgresMajorUpgradeService, "get").mockImplementation(
  getUpgradeStatus as typeof upgradeModule.postgresMajorUpgradeService.get,
);
const requestUpgradeSpy = spyOn(upgradeModule.postgresMajorUpgradeService, "request").mockImplementation(
  requestUpgrade as typeof upgradeModule.postgresMajorUpgradeService.request,
);

const { projectCrudRoutes } = await import("../../src/routes/project-crud");

const app = new Elysia().use(projectCrudRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer dev-master-token",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    }),
  );
}

describe("project platform capability endpoints", () => {
  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    getProjectSpy.mockRestore();
    listBackupsSpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    getUpgradeStatusSpy.mockRestore();
    requestUpgradeSpy.mockRestore();
  });

  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(null);
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    getProject.mockReset();
    getProject.mockResolvedValue({
      ref: "proj_1",
      name: "Project One",
      status: "active",
      database: { version: "15.7" },
    } as never);
    listBackups.mockReset();
    listBackups.mockResolvedValue([]);
    resolveDbName.mockReset();
    resolveDbName.mockImplementation((ref: string) => Promise.resolve(`supa_${ref}`));
    getUpgradeStatus.mockReset();
    getUpgradeStatus.mockResolvedValue({
      status: "available",
      capability: true,
      available: true,
      scope: "cluster",
      current_version: "15",
      target_version: null,
      upgrade_status: "not_started",
    });
    requestUpgrade.mockReset();
    requestUpgrade.mockResolvedValue({ id: "upgrade-1", status: "awaiting_approval", scope: "cluster" });
    delete process.env.SUPACLOUD_PGBACKREST_STANZA;
    delete process.env.SUPACLOUD_PITR_ENABLED;
    delete process.env.PITR_ENABLED;
  });

  test("GET upgrade-status returns the durable cluster upgrade capability state", async () => {
    const res = await request("/v1/projects/proj_1/upgrade-status");
    expect(res.status).toBe(200);

    expect(await res.json()).toMatchObject({
      upgrade_status: "not_started",
      status: "available",
      capability: true,
      available: true,
      current_version: "15",
      target_version: null,
      scope: "cluster",
    });
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "proj_1");
  });

  test("POST upgrade starts preflight without executing the destructive phase", async () => {
    const res = await request("/v1/projects/proj_1/upgrade", {
      method: "POST",
      body: JSON.stringify({ target_version: "16" }),
    });
    expect(res.status).toBe(202);

    expect(await res.json()).toMatchObject({
      id: "upgrade-1",
      status: "awaiting_approval",
      scope: "cluster",
    });
    expect(requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(requestUpgrade).toHaveBeenCalledWith("proj_1", "16");
  });

  test("GET PITR returns disabled capability state when cluster PITR is not enabled", async () => {
    listBackups.mockResolvedValue([
      {
        id: "20260619-010203F",
        type: "full",
        timestamp: { start: 1_782_000_000, stop: 1_782_003_600 },
        size: 1024,
        database: "supa_proj_1",
      },
    ] as never);

    const res = await request("/v1/projects/proj_1/database/backups/pitr");
    expect(res.status).toBe(200);

    expect(await res.json()).toMatchObject({
      available: false,
      capability: false,
      status: "unsupported",
      reason: "pitr_not_enabled",
      earliest_physical_backup_date: "2026-06-21T00:00:00.000Z",
      latest_physical_backup_date: "2026-06-21T01:00:00.000Z",
      backups: { count: 1, stanza: "db-main" },
      restore: {
        supported: false,
        endpoint: "/v1/platform/backups/restore",
        requires_admin: true,
      },
    });
    expect(listBackups).toHaveBeenCalledWith("supa_proj_1");
  });

  test("GET PITR reports available only when PITR flag and physical backups are present", async () => {
    process.env.SUPACLOUD_PITR_ENABLED = "true";
    listBackups.mockResolvedValue([
      {
        id: "20260619-010203F",
        type: "full",
        timestamp: { start: 1_782_000_000, stop: 1_782_003_600 },
        size: 1024,
        database: "supa_proj_1",
      },
    ] as never);

    const res = await request("/v1/projects/proj_1/database/backups/pitr");
    expect(res.status).toBe(200);

    expect(await res.json()).toMatchObject({
      available: true,
      capability: true,
      status: "available",
      reason: null,
      restore: { supported: true },
    });
  });

  test("GET PITR reports the configured cluster stanza instead of the tenant database", async () => {
    process.env.SUPACLOUD_PGBACKREST_STANZA = "cluster-main";
    try {
      const res = await request("/v1/projects/proj_1/database/backups/pitr");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ backups: { stanza: "cluster-main" } });
      expect(listBackups).toHaveBeenCalledWith("supa_proj_1");
    } finally {
      delete process.env.SUPACLOUD_PGBACKREST_STANZA;
    }
  });
});
