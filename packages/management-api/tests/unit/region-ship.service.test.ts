// @supacloud-test-isolate — mocks project lookup and the logical backup archive reader.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogicalBackupIdentity } from "../../src/types/backup";

const payload = Buffer.from("region-ship-archive");
const backupId = `logical-full_project-a_${"ab".repeat(16)}`;
const identity: LogicalBackupIdentity = {
  backup_id: backupId,
  project_ref: "project-a",
  database: "tenant_database_a",
  kind: "logical-full",
  created_at: "2026-08-05T00:00:00.000Z",
  completed_at: "2026-08-05T00:00:01.000Z",
  bytes: payload.byteLength,
  sha256: createHash("sha256").update(payload).digest("hex"),
};

const projects = new Map<string, { ref: string; region: string }>();
const findByRef = mock(async (projectRef: string) => projects.get(projectRef) ?? null);
const readLogicalBackup = mock(async () => identity);
const copyVerifiedLogicalBackupArchive = mock(async (
  _projectRef: string,
  _backupId: string,
  write: (chunk: Uint8Array) => Promise<void>,
) => {
  await write(payload);
  return identity;
});

class LogicalBackupContractError extends Error {
  constructor(readonly kind: "invalid_request" | "not_found" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "LogicalBackupContractError";
  }
}

const shipRootParent = await realpathSafe(await mkdtemp(join(homedir(), ".supacloud-region-ship-test-")));
const shipRoot = join(shipRootParent, "region-ship");
process.env.SUPACLOUD_REGION_SHIP_DIR = shipRoot;

async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: { findByRef },
}));
mock.module("../../src/config", () => ({
  config: { secretsEncryptionKey: "region-ship-test-signing-key-32b" },
}));
mock.module("../../src/services/logical-backup.service", () => ({
  LogicalBackupContractError,
  readLogicalBackup,
  copyVerifiedLogicalBackupArchive,
}));
mock.module("../../src/utils/logger", () => ({
  logger: { error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
}));

const {
  REGION_SHIP_TARGET_APPLY,
  RegionShipError,
  readRegionShip,
  shipVerifiedLogicalBackupToRegion,
} = await import("../../src/services/region-ship.service");

afterAll(async () => {
  await rm(shipRootParent, { recursive: true, force: true });
  delete process.env.SUPACLOUD_REGION_SHIP_DIR;
});

function project(region: string): { ref: string; region: string } {
  return { ref: "project-a", region };
}

function archivePath(targetRegion = "us-east-1"): string {
  return join(shipRoot, targetRegion, "project-a", `${backupId}.dump`);
}

describe("region ship", () => {
  beforeEach(async () => {
    await rm(shipRoot, { recursive: true, force: true });
    projects.clear();
    projects.set("project-a", project("local"));
    findByRef.mockClear();
    readLogicalBackup.mockClear();
    copyVerifiedLogicalBackupArchive.mockClear();
    readLogicalBackup.mockImplementation(async () => identity);
    copyVerifiedLogicalBackupArchive.mockImplementation(async (_projectRef, _backupId, write) => {
      await write(payload);
      return identity;
    });
  });

  test("copies a verified logical backup into the target region directory", async () => {
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("target region process was started");
    });
    try {
      const ship = await shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-east-1");
      const stored = JSON.parse(await readFile(join(shipRoot, "us-east-1", "project-a", `${backupId}.json`), "utf8"));

      expect(ship).toMatchObject({
        schema: "supacloud.region-ship.v1",
        project_ref: "project-a",
        backup_id: backupId,
        database: "tenant_database_a",
        source_region: "local",
        target_region: "us-east-1",
        bytes: payload.byteLength,
        sha256: identity.sha256,
        transport: "loopback",
        target_apply: "not executed",
      });
      expect(ship.target_apply).toBe(REGION_SHIP_TARGET_APPLY);
      expect(stored.target_apply).toBe("not executed");
      expect(stored.transport).toBe("loopback");
      expect(await readFile(archivePath())).toEqual(payload);
      expect((await stat(shipRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(archivePath())).mode & 0o777).toBe(0o600);
      expect(copyVerifiedLogicalBackupArchive).toHaveBeenCalledTimes(1);
      expect(spawnSpy).not.toHaveBeenCalled();

      const observed = await readRegionShip("project-a", backupId, "us-east-1");
      expect(observed).toEqual(ship);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("writes the receipt when the archive is already stored and target apply stays not executed", async () => {
    const first = await shipVerifiedLogicalBackupToRegion("project-a", backupId, "eu-west-1");
    await rm(join(shipRoot, "eu-west-1", "project-a", `${backupId}.json`));

    await expect(readRegionShip("project-a", backupId, "eu-west-1"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "conflict" });
    const repaired = await shipVerifiedLogicalBackupToRegion("project-a", backupId, "eu-west-1");

    expect(repaired.sha256).toBe(first.sha256);
    expect(repaired.target_apply).toBe("not executed");
    expect(repaired.transport).toBe("loopback");
    expect(copyVerifiedLogicalBackupArchive).toHaveBeenCalledTimes(1);
  });

  test("returns the stored receipt when the same archive is already present", async () => {
    const first = await shipVerifiedLogicalBackupToRegion("project-a", backupId, "eu-west-1");
    const second = await shipVerifiedLogicalBackupToRegion("project-a", backupId, "eu-west-1");

    expect(second).toEqual(first);
    expect(copyVerifiedLogicalBackupArchive).toHaveBeenCalledTimes(1);
    expect(second.target_apply).toBe("not executed");
  });

  test("conflicts when the stored archive bytes differ", async () => {
    await shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-west-1");
    await writeFile(archivePath("us-west-1"), Buffer.from("different-archive"), { mode: 0o600 });

    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-west-1"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "conflict" });
    expect(copyVerifiedLogicalBackupArchive).toHaveBeenCalledTimes(1);
  });

  test("rejects a target region that matches the project region before reading the archive", async () => {
    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "local"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "invalid_request" });
    expect(readLogicalBackup).not.toHaveBeenCalled();
    expect(copyVerifiedLogicalBackupArchive).not.toHaveBeenCalled();
  });

  test("rejects an unknown target region", async () => {
    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "mars"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "invalid_request" });
    expect(readLogicalBackup).not.toHaveBeenCalled();
  });

  test("rejects a project region outside the region catalog", async () => {
    projects.set("project-a", project("custom-dc"));

    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-east-1"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "invalid_request" });
    expect(readLogicalBackup).not.toHaveBeenCalled();
  });

  test("read of a missing ship does not create the directory", async () => {
    await expect(readRegionShip("project-a", backupId, "ap-southeast-1"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "not_found" });
    await expect(stat(shipRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(copyVerifiedLogicalBackupArchive).not.toHaveBeenCalled();
  });

  test("does not copy through a symlinked target region directory", async () => {
    await mkdir(shipRoot, { mode: 0o700 });
    await chmod(shipRoot, 0o700);
    const outside = join(shipRootParent, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(shipRoot, "us-east-1"));

    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-east-1"))
      .rejects.toBeInstanceOf(RegionShipError);
    expect(copyVerifiedLogicalBackupArchive).not.toHaveBeenCalled();
    expect(await readFile(join(outside, "project-a", `${backupId}.dump`)).catch((error: NodeJS.ErrnoException) => error.code))
      .toBe("ENOENT");
  });

  test("maps a missing logical backup without copying", async () => {
    readLogicalBackup.mockRejectedValueOnce(new LogicalBackupContractError("not_found", "Logical backup not found"));

    await expect(shipVerifiedLogicalBackupToRegion("project-a", backupId, "us-east-1"))
      .rejects.toMatchObject({ name: "RegionShipError", kind: "not_found", message: "Logical backup not found" });
    expect(copyVerifiedLogicalBackupArchive).not.toHaveBeenCalled();
  });
});
