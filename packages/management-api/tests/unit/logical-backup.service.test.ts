// @supacloud-test-isolate — mocks tenant lookup and database subprocesses.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface SpawnInvocation {
  cmd: string[];
  env?: Record<string, string | undefined>;
}

const adminPassword = "admin-secret";
let projectStatus = "paused";
const findByRef = mock(async () => ({
  ref: "project-a",
  status: projectStatus,
}));
const resolveDbName = mock(async () => "tenant_database");
const logicalBackupDirectory = await mkdtemp(join(tmpdir(), "supacloud-logical-backup-test-"));
const previousLogicalBackupDirectory = process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = logicalBackupDirectory;

mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: { findByRef },
}));
mock.module("../../src/db", () => ({ resolveDbName }));
mock.module("../../src/config", () => ({
  config: {
    pgHost: "database.internal",
    pgPort: 6432,
    pgUser: "postgres-admin",
    pgPassword: adminPassword,
  },
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
const commandExitCodes: number[] = [];
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
  spawnInvocations.push(options);
  const exitCode = commandExitCodes.shift() ?? 0;
  const outputPathIndex = options.cmd.indexOf("-f");
  const writeArchive = options.cmd[0] === "pg_dump" && exitCode === 0 && outputPathIndex >= 0
    ? writeFile(options.cmd[outputPathIndex + 1] || "", "archive")
    : Promise.resolve();
  return {
    exited: writeArchive.then(() => exitCode),
    stderr: new Blob([]).stream(),
  } as never;
}) as typeof Bun.spawn);

describe("logical backup database endpoint", () => {
  beforeEach(() => {
    projectStatus = "paused";
    commandExitCodes.length = 0;
    spawnInvocations.length = 0;
    findByRef.mockClear();
    resolveDbName.mockClear();
  });

  afterAll(async () => {
    spawnSpy.mockRestore();
    await rm(logicalBackupDirectory, { recursive: true, force: true });
    if (previousLogicalBackupDirectory === undefined) delete process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
    else process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = previousLogicalBackupDirectory;
  });

  test("uses the control-plane PostgreSQL identity and validates the archive", async () => {
    const backup = await createLogicalBackup("project-a");
    expect(backup.success).toBe(true);
    const createdBackupPath = join(logicalBackupDirectory, String(backup.file));
    expect((await stat(createdBackupPath)).mode & 0o777).toBe(0o600);

    const backupId = "backup_project-a_2026-08-04T00-00-00-000Z.sql.gz";
    await writeFile(join(logicalBackupDirectory, backupId), "archive");
    await expect(restoreLogicalBackup("project-a", backupId)).resolves.toMatchObject({ success: true });

    expect(spawnInvocations.map(({ cmd }) => cmd[0])).toEqual([
      "pg_dump", "pg_restore", "pg_restore", "pg_restore",
    ]);
    expect(spawnInvocations[0]?.cmd).toEqual(expect.arrayContaining([
      "-h", "database.internal", "-p", "6432", "-U", "postgres-admin",
      "-d", "tenant_database", "-F", "c", "-Z", "6", "-f",
    ]));
    expect(spawnInvocations[3]?.cmd).toEqual(expect.arrayContaining([
      "-U", "postgres-admin", "-d", "tenant_database", "-c", "--if-exists",
      "--exit-on-error", "-1",
    ]));
    expect(spawnInvocations[1]?.cmd).toEqual(["pg_restore", "--list", createdBackupPath]);
    expect(spawnInvocations.filter(({ env }) => env).every(({ env }) => env?.PGPASSWORD === adminPassword)).toBe(true);
    expect(JSON.stringify(spawnInvocations.map(({ cmd }) => cmd))).not.toContain(adminPassword);
  });

  test("does not report a failed database subprocess as a successful backup", async () => {
    commandExitCodes.push(9);

    await expect(createLogicalBackup("project-a")).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("pg_dump exited with code 9"),
    });
  });

  test("does not report a failed database subprocess as a successful restore", async () => {
    const backupId = "backup_project-a_2026-08-04T00-00-00-001Z.sql.gz";
    await writeFile(join(logicalBackupDirectory, backupId), "archive");
    commandExitCodes.push(0, 8);

    await expect(restoreLogicalBackup("project-a", backupId)).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("pg_restore exited with code 8"),
    });
    expect(await Bun.file(join(logicalBackupDirectory, backupId)).exists()).toBe(true);
  });

  test("requires a paused project before starting a destructive restore", async () => {
    const backupId = "backup_project-a_2026-08-04T00-00-00-002Z.sql.gz";
    await writeFile(join(logicalBackupDirectory, backupId), "archive");
    projectStatus = "active";

    await expect(restoreLogicalBackup("project-a", backupId)).resolves.toEqual({
      success: false,
      message: "Project must be paused before logical restore",
      reason: "project_not_paused",
    });
    expect(spawnInvocations).toEqual([]);
  });
});
