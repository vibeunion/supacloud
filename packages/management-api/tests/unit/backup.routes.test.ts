import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const resolveDbName = mock((ref: string) => Promise.resolve(`supa_${ref}`));
const listBackups = mock(() => Promise.resolve([]));
const createBackup = mock(() => Promise.resolve({ message: "full backup completed" }));
const restore = mock(() => Promise.resolve({ message: "PITR restore completed" }));

const authModule = await import("../../src/middleware/auth");
const dbModule = await import("../../src/db");
const backupModule = await import("../../src/services/backup.service");

const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const resolveDbNameSpy = spyOn(dbModule, "resolveDbName").mockImplementation(
  resolveDbName as typeof dbModule.resolveDbName,
);
const listBackupsSpy = spyOn(backupModule, "listBackups").mockImplementation(
  listBackups as typeof backupModule.listBackups,
);
const createBackupSpy = spyOn(backupModule, "createBackup").mockImplementation(
  createBackup as typeof backupModule.createBackup,
);
const restoreSpy = spyOn(backupModule, "restore").mockImplementation(
  restore as typeof backupModule.restore,
);

const { backupRoutes } = await import("../../src/routes/backups");
const { projectConfigRoutes } = await import("../../src/routes/project-config");
const app = new Elysia().use(backupRoutes);

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer dev-master-token",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }));
}

describe("physical backup routes", () => {
  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(null);
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    resolveDbName.mockReset();
    resolveDbName.mockImplementation((ref: string) => Promise.resolve(`supa_${ref}`));
    listBackups.mockReset();
    listBackups.mockResolvedValue([]);
    createBackup.mockReset();
    createBackup.mockResolvedValue({ message: "full backup completed" });
    restore.mockReset();
    restore.mockResolvedValue({ message: "PITR restore completed" });
    delete process.env.SUPACLOUD_PITR_ENABLED;
    delete process.env.PITR_ENABLED;
  });

  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    listBackupsSpy.mockRestore();
    createBackupSpy.mockRestore();
    restoreSpy.mockRestore();
  });

  test("lists cluster inventory under the requested project database", async () => {
    listBackups.mockResolvedValue([{
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
      database: "supa_project_a",
    }]);

    const response = await request("/v1/projects/project_a/database/backups");
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(1);
    expect(listBackups).toHaveBeenCalledWith("supa_project_a");
  });

  test("reports backup success only after the service returns a completed result", async () => {
    const response = await request("/v1/projects/project_a/database/backups", {
      method: "POST",
      body: JSON.stringify({ type: "full" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "full backup completed" });
    expect(createBackup).toHaveBeenCalledWith("full");
  });

  test("returns 503 instead of an empty list or started response on pgBackRest failure", async () => {
    listBackups.mockRejectedValueOnce(new backupModule.PgBackRestUnavailableError("pgBackRest backup inventory failed"));
    const listResponse = await request("/v1/projects/project_a/database/backups");
    expect(listResponse.status).toBe(503);
    expect(await listResponse.json()).toEqual({ message: "pgBackRest backup inventory is unavailable" });

    createBackup.mockRejectedValueOnce(new backupModule.PgBackRestUnavailableError("pgBackRest backup failed"));
    const createResponse = await request("/v1/projects/project_a/database/backups", {
      method: "POST",
      body: JSON.stringify({ type: "full" }),
    });
    expect(createResponse.status).toBe(503);
    expect(await createResponse.json()).toEqual({ message: "pgBackRest backup failed" });
  });

  test("exposes PITR only at the platform endpoint, requires exact confirmation, and reports execution failure", async () => {
    const target = "2026-07-22T01:30:00Z";
    const confirmation = `RESTORE_CLUSTER:${target}`;
    const projectResponse = await request("/v1/projects/project_a/database/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation }),
    });
    expect(projectResponse.status).toBe(404);
    expect(restore).not.toHaveBeenCalled();

    const unconfirmedResponse = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation: "RESTORE_CLUSTER" }),
    });
    expect(unconfirmedResponse.status).toBe(400);
    expect(restore).not.toHaveBeenCalled();

    const disabledResponse = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation }),
    });
    expect(disabledResponse.status).toBe(409);
    expect(restore).not.toHaveBeenCalled();

    process.env.SUPACLOUD_PITR_ENABLED = "true";
    const noBackupResponse = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation }),
    });
    expect(noBackupResponse.status).toBe(409);
    expect(restore).not.toHaveBeenCalled();

    listBackups.mockResolvedValueOnce([{
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
    }]);

    const successResponse = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation }),
    });
    expect(successResponse.status).toBe(200);
    expect(restore).toHaveBeenCalledWith({ target });

    listBackups.mockResolvedValueOnce([{
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
    }]);
    restore.mockRejectedValueOnce(new backupModule.PitrRestoreUnavailableError("PITR restore failed"));
    const failureResponse = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({ target, confirmation }),
    });
    expect(failureResponse.status).toBe(503);
  });

  test("requires admin authentication before checking PITR capability or inventory", async () => {
    requireAdminAuth.mockResolvedValueOnce({ status: 401, body: { error: "Unauthorized" } } as never);

    const response = await request("/v1/platform/backups/restore", {
      method: "POST",
      body: JSON.stringify({
        target: "2026-07-22T01:30:00Z",
        confirmation: "RESTORE_CLUSTER:2026-07-22T01:30:00Z",
      }),
    });

    expect(response.status).toBe(401);
    expect(listBackups).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  test("does not leave a second backup or restore contract in project config routes", () => {
    const duplicatePaths = projectConfigRoutes.routes
      .filter((route) => route.path === "/v1/projects/:ref/database/backups" || route.path === "/v1/projects/:ref/database/backups/restore");
    expect(duplicatePaths).toHaveLength(0);
  });
});
