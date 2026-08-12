import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { withLogicalBackupMutationTimeoutController } from "../../src/utils/logical-backup-request-timeout";

const requireAdminAuth = mock(() => Promise.resolve(null));
const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
type BackupProject = { ref: string; db_name: string };
const findByRef = mock((ref: string): Promise<BackupProject | null> => (
  Promise.resolve({ ref, db_name: "canonical_project_database" })
));
const listBackups = mock(() => Promise.resolve([]));
const createBackup = mock(() => Promise.resolve({ message: "full backup completed" }));
const logicalBackupIdentity = {
  backup_id: "logical-full_project_a_0123456789abcdef0123456789abcdef",
  project_ref: "project_a",
  database: "canonical_project_database",
  kind: "logical-full" as const,
  created_at: "2026-08-05T00:00:00.000Z",
  completed_at: "2026-08-05T00:00:01.000Z",
  bytes: 7,
  sha256: "a".repeat(64),
};
const listLogicalBackups = mock(() => Promise.resolve([logicalBackupIdentity]));
const createLogicalBackup = mock(() => Promise.resolve(logicalBackupIdentity));
const restoreLogicalBackup = mock(() => Promise.resolve(logicalBackupIdentity));
const restore = mock(() => Promise.resolve({ message: "PITR restore completed" }));

const authModule = await import("../../src/middleware/auth");
const backupModule = await import("../../src/services/backup.service");
const logicalBackupModule = await import("../../src/services/logical-backup.service");
const { projectRepository } = await import("../../src/repositories/project.repository");

const requireAdminAuthSpy = spyOn(authModule, "requireAdminAuth").mockImplementation(
  requireAdminAuth as typeof authModule.requireAdminAuth,
);
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(
  findByRef as typeof projectRepository.findByRef,
);
const listBackupsSpy = spyOn(backupModule, "listBackups").mockImplementation(
  listBackups as typeof backupModule.listBackups,
);
const createBackupSpy = spyOn(backupModule, "createBackup").mockImplementation(
  createBackup as typeof backupModule.createBackup,
);
const listLogicalBackupsSpy = spyOn(logicalBackupModule, "listLogicalBackups").mockImplementation(
  listLogicalBackups as typeof logicalBackupModule.listLogicalBackups,
);
const createLogicalBackupV2Spy = spyOn(logicalBackupModule, "createLogicalBackup").mockImplementation(
  createLogicalBackup as typeof logicalBackupModule.createLogicalBackup,
);
const restoreLogicalBackupSpy = spyOn(logicalBackupModule, "restoreLogicalBackup").mockImplementation(
  restoreLogicalBackup as typeof logicalBackupModule.restoreLogicalBackup,
);
const restoreSpy = spyOn(backupModule, "restore").mockImplementation(
  restore as typeof backupModule.restore,
);

const { backupRoutes } = await import("../../src/routes/backups");
const { projectConfigRoutes } = await import("../../src/routes/project-config");
const app = new Elysia().use(backupRoutes);

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer dev-master-token",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function request(path: string, init: RequestInit = {}) {
  return app.handle(adminRequest(path, init));
}

describe("physical backup routes", () => {
  beforeEach(() => {
    requireAdminAuth.mockReset();
    requireAdminAuth.mockResolvedValue(null);
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);
    findByRef.mockReset();
    findByRef.mockImplementation((ref: string) => Promise.resolve({
      ref,
      db_name: "canonical_project_database",
    }));
    listBackups.mockReset();
    listBackups.mockResolvedValue([]);
    createBackup.mockReset();
    createBackup.mockResolvedValue({ message: "full backup completed" });
    createLogicalBackup.mockReset();
    createLogicalBackup.mockResolvedValue(logicalBackupIdentity);
    listLogicalBackups.mockReset();
    listLogicalBackups.mockResolvedValue([logicalBackupIdentity]);
    restoreLogicalBackup.mockReset();
    restoreLogicalBackup.mockResolvedValue(logicalBackupIdentity);
    restore.mockReset();
    restore.mockResolvedValue({ message: "PITR restore completed" });
    delete process.env.SUPACLOUD_PITR_ENABLED;
    delete process.env.PITR_ENABLED;
  });

  afterAll(() => {
    requireAdminAuthSpy.mockRestore();
    requireProjectOrAdminAuthSpy.mockRestore();
    findByRefSpy.mockRestore();
    listBackupsSpy.mockRestore();
    createBackupSpy.mockRestore();
    listLogicalBackupsSpy.mockRestore();
    createLogicalBackupV2Spy.mockRestore();
    restoreLogicalBackupSpy.mockRestore();
    restoreSpy.mockRestore();
  });

  test("lists cluster inventory under the persisted project database name", async () => {
    listBackups.mockResolvedValue([{
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
      database: "canonical_project_database",
    }]);

    const response = await request("/v1/projects/project_a/database/backups");
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(1);
    expect(findByRef).toHaveBeenCalledWith("project_a");
    expect(listBackups).toHaveBeenCalledWith("canonical_project_database");
  });

  test("reports backup success only after the service returns a completed result", async () => {
    const response = await request("/v1/projects/project_a/database/backups", {
      method: "POST",
      body: JSON.stringify({ type: "full" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "full backup completed" });
    expect(findByRef).toHaveBeenCalledWith("project_a");
    expect(createBackup).toHaveBeenCalledWith("full");
  });

  test("rejects unknown project refs before physical backup reads or writes", async () => {
    findByRef.mockResolvedValue(null);

    const listResponse = await request("/v1/projects/missing/database/backups");
    const createResponse = await request("/v1/projects/missing/database/backups", {
      method: "POST",
      body: JSON.stringify({ type: "full" }),
    });

    expect(listResponse.status).toBe(404);
    expect(await listResponse.json()).toEqual({ message: "Project not found" });
    expect(createResponse.status).toBe(404);
    expect(await createResponse.json()).toEqual({ message: "Project not found" });
    expect(findByRef).toHaveBeenCalledTimes(2);
    expect(listBackups).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
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

  test("maps logical backup contract errors without reflecting internal failures", async () => {
    createLogicalBackup.mockRejectedValueOnce(new logicalBackupModule.LogicalBackupContractError(
      "unavailable",
      "Logical backup creation is unavailable",
      { cause: new Error("password=secret /absolute/archive pg_dump stderr") },
    ));

    const response = await request("/v1/projects/project_a/database/backups/logical", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Logical backup creation is unavailable" });
  });

  test("lists and creates only after admin authentication", async () => {
    const inventoryResponse = await request("/v1/projects/project_a/database/backups/logical");
    expect(inventoryResponse.status).toBe(200);
    expect(await inventoryResponse.json()).toEqual({ backups: [logicalBackupIdentity] });

    const createResponse = await request("/v1/projects/project_a/database/backups/logical", {
      method: "POST",
      body: "{}",
    });
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({ backup: logicalBackupIdentity });

    requireAdminAuth.mockResolvedValueOnce({ status: 403, body: { error: "Forbidden" } } as never);
    const deniedResponse = await request("/v1/projects/project_a/database/backups/logical");
    expect(deniedResponse.status).toBe(403);
    expect(listLogicalBackups).toHaveBeenCalledTimes(1);
  });

  test("disables the idle timeout for authorized logical mutations", async () => {
    const timeout = mock(() => undefined);
    const createRequest = adminRequest("/v1/projects/project%5Fa/database/backups/logical", {
      method: "POST",
      body: "{}",
    });
    const createResponse = await withLogicalBackupMutationTimeoutController(
      createRequest,
      { timeout },
      () => app.handle(createRequest),
    );
    const backupId = logicalBackupIdentity.backup_id;
    const expectedSha256 = logicalBackupIdentity.sha256;
    const restoreRequest = adminRequest("/v1/projects/project%5Fa/database/backups/logical/restore", {
      method: "POST",
      body: JSON.stringify({
        backup_id: backupId,
        expected_sha256: expectedSha256,
        confirmation: `RESTORE_PROJECT:project_a:${backupId}:${expectedSha256}`,
      }),
    });
    const restoreResponse = await withLogicalBackupMutationTimeoutController(
      restoreRequest,
      { timeout },
      () => app.handle(restoreRequest),
    );

    expect(createResponse.status).toBe(200);
    expect(restoreResponse.status).toBe(200);
    expect(timeout.mock.calls).toEqual([
      [createRequest, 0],
      [restoreRequest, 0],
    ]);
  });

  test("keeps the idle timeout for unauthorized or unconfirmed logical mutations", async () => {
    const timeout = mock(() => undefined);
    requireAdminAuth.mockResolvedValueOnce({ status: 401, body: { error: "Unauthorized" } } as never);
    const createRequest = adminRequest("/v1/projects/project_a/database/backups/logical", {
      method: "POST",
      body: "{}",
    });
    const createResponse = await withLogicalBackupMutationTimeoutController(
      createRequest,
      { timeout },
      () => app.handle(createRequest),
    );
    const restoreRequest = adminRequest("/v1/projects/project_a/database/backups/logical/restore", {
      method: "POST",
      body: JSON.stringify({
        backup_id: logicalBackupIdentity.backup_id,
        expected_sha256: logicalBackupIdentity.sha256,
        confirmation: "RESTORE_PROJECT",
      }),
    });
    const restoreResponse = await withLogicalBackupMutationTimeoutController(
      restoreRequest,
      { timeout },
      () => app.handle(restoreRequest),
    );

    expect(createResponse.status).toBe(401);
    expect(restoreResponse.status).toBe(400);
    expect(timeout).not.toHaveBeenCalled();
    expect(createLogicalBackup).not.toHaveBeenCalled();
    expect(restoreLogicalBackup).not.toHaveBeenCalled();
  });

  test("requires exact identity confirmation and maps paused restore to 409", async () => {
    const backupId = logicalBackupIdentity.backup_id;
    const expectedSha256 = logicalBackupIdentity.sha256;
    const unconfirmed = await request("/v1/projects/project_a/database/backups/logical/restore", {
      method: "POST",
      body: JSON.stringify({
        backup_id: backupId,
        expected_sha256: expectedSha256,
        confirmation: "RESTORE_PROJECT",
      }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(restoreLogicalBackup).not.toHaveBeenCalled();

    restoreLogicalBackup.mockRejectedValueOnce(new logicalBackupModule.LogicalBackupContractError(
      "conflict",
      "Project must be paused before logical restore",
    ));
    const pausedRequired = await request("/v1/projects/project_a/database/backups/logical/restore", {
      method: "POST",
      body: JSON.stringify({
        backup_id: backupId,
        expected_sha256: expectedSha256,
        confirmation: `RESTORE_PROJECT:project_a:${backupId}:${expectedSha256}`,
      }),
    });
    expect(pausedRequired.status).toBe(409);
    expect(restoreLogicalBackup).toHaveBeenCalledWith({
      project_ref: "project_a",
      backup_id: backupId,
      expected_sha256: expectedSha256,
      confirmation: `RESTORE_PROJECT:project_a:${backupId}:${expectedSha256}`,
    });
  });

  test("does not leave a second backup or restore contract in project config routes", () => {
    const duplicatePaths = projectConfigRoutes.routes
      .filter((route) => route.path === "/v1/projects/:ref/database/backups" || route.path === "/v1/projects/:ref/database/backups/restore");
    expect(duplicatePaths).toHaveLength(0);
  });
});
