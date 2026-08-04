// @supacloud-test-isolate — mocks tenant lookup and database subprocesses.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface SpawnInvocation {
  cmd: string[];
  env?: Record<string, string | undefined>;
}

const projectPassword = "tenant-secret";
const findByRef = mock(async () => ({
  ref: "project-a",
  db_password: projectPassword,
  s3_access_key: null,
  s3_secret_key: null,
}));
const resolveDbName = mock(async () => "tenant_database");
const resolveRoleName = mock(() => "tenant_role");
const logicalBackupDirectory = await mkdtemp(join(tmpdir(), "supacloud-logical-backup-test-"));
const previousLogicalBackupDirectory = process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = logicalBackupDirectory;

mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: { findByRef },
}));
mock.module("../../src/db", () => ({ resolveDbName, resolveRoleName }));
mock.module("../../src/config", () => ({
  config: { pgHost: "database.internal", pgPort: 6432 },
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { createLogicalBackup, restoreLogicalBackup } = await import(
  new URL("../../src/services/backup.service.ts?logical-backup-service-test", import.meta.url).href,
);

const spawnInvocations: SpawnInvocation[] = [];
let databaseProcessExitCode = 0;
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
  spawnInvocations.push(options);
  return {
    exited: Promise.resolve(databaseProcessExitCode),
    stderr: new Blob([]).stream(),
  } as never;
}) as typeof Bun.spawn);

describe("logical backup database endpoint", () => {
  beforeEach(() => {
    databaseProcessExitCode = 0;
    spawnInvocations.length = 0;
    findByRef.mockClear();
    resolveDbName.mockClear();
    resolveRoleName.mockClear();
  });

  afterAll(async () => {
    spawnSpy.mockRestore();
    await rm(logicalBackupDirectory, { recursive: true, force: true });
    if (previousLogicalBackupDirectory === undefined) delete process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
    else process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = previousLogicalBackupDirectory;
  });

  test("uses the configured PostgreSQL endpoint for dump and restore", async () => {
    const backup = await createLogicalBackup("project-a");
    expect(backup.success).toBe(true);

    const backupId = "backup_project-a_2026-08-04T00-00-00-000Z.sql.gz";
    await writeFile(join(logicalBackupDirectory, backupId), "archive");
    await expect(restoreLogicalBackup("project-a", backupId)).resolves.toMatchObject({ success: true });

    expect(spawnInvocations.map(({ cmd }) => cmd.slice(0, 5))).toEqual([
      ["pg_dump", "-h", "database.internal", "-p", "6432"],
      ["pg_restore", "-h", "database.internal", "-p", "6432"],
    ]);
    expect(spawnInvocations[0]?.cmd).toEqual(expect.arrayContaining([
      "-U", "tenant_role", "-d", "tenant_database", "-F", "c", "-Z", "6", "-f",
    ]));
    expect(spawnInvocations[1]?.cmd).toEqual(expect.arrayContaining([
      "-U", "tenant_role", "-d", "tenant_database", "-c", "-1",
    ]));
    expect(spawnInvocations.every(({ env }) => env?.PGPASSWORD === projectPassword)).toBe(true);
    expect(JSON.stringify(spawnInvocations.map(({ cmd }) => cmd))).not.toContain(projectPassword);
  });

  test("does not report a failed database subprocess as a successful backup", async () => {
    databaseProcessExitCode = 9;

    await expect(createLogicalBackup("project-a")).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("pg_dump exited with code 9"),
    });
  });

  test("does not report a failed database subprocess as a successful restore", async () => {
    const backupId = "backup_project-a_2026-08-04T00-00-00-001Z.sql.gz";
    await writeFile(join(logicalBackupDirectory, backupId), "archive");
    databaseProcessExitCode = 8;

    await expect(restoreLogicalBackup("project-a", backupId)).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("pg_restore exited with code 8"),
    });
  });
});
