import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const requireAdminAuth = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const resolveDbName = mock((ref: string) => Promise.resolve(`supa_${ref}`));
const listBackups = mock(() => Promise.resolve([]));
const createBackup = mock(() => Promise.resolve({ message: "full backup completed" }));

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
  });

  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    resolveDbNameSpy.mockRestore();
    listBackupsSpy.mockRestore();
    createBackupSpy.mockRestore();
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

  test("does not leave a second backup or restore contract in project config routes", () => {
    const duplicatePaths = projectConfigRoutes.routes
      .filter((route) => route.path === "/v1/projects/:ref/database/backups" || route.path === "/v1/projects/:ref/database/backups/restore");
    expect(duplicatePaths).toHaveLength(0);
  });
});
