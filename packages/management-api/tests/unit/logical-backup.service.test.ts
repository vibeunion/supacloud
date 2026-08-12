// @supacloud-test-isolate — mocks project lookup and PostgreSQL subprocesses.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stableStringify } from "../../src/utils/stable-json";

interface SpawnInvocation {
  cmd: string[];
  env?: Record<string, string | undefined>;
  stdin?: number | string;
  stdout?: number | string;
  stderr?: number | string;
}

type TestProject = {
  ref: string;
  db_name: string;
  status: string;
};

const projects = new Map<string, TestProject>();
const findByRef = mock(async (projectRef: string) => projects.get(projectRef) ?? null);
const loggerError = mock(() => undefined);
const logicalBackupTestRoot = await realpath(
  await mkdtemp(join(tmpdir(), "supacloud-logical-backup-test-root-")),
);
const logicalBackupDirectory = join(logicalBackupTestRoot, "nested", "logical-full");
const previousLogicalBackupDirectory = process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = logicalBackupDirectory;
const currentSigningKey = "logical-backup-current-test-signing-key";
const legacySigningKey = "logical-backup-legacy-test-signing-key";
const configMock = {
  pgHost: "database.internal",
  pgPort: 6432,
  pgUser: "postgres-admin",
  pgPassword: "admin-secret",
  secretsEncryptionKey: currentSigningKey,
  legacySecretsEncryptionKey: legacySigningKey,
};
let migrationLocked = false;
class ProjectMigrationLockError extends Error {
  constructor(readonly projectRef: string) {
    super(`migration locked: ${projectRef}`);
    this.name = "ProjectMigrationLockError";
  }
}
const withProjectMigrationLocks = mock(async (
  _input: { projectRefs: readonly string[] },
  operation: () => Promise<unknown>,
) => {
  if (migrationLocked) {
    throw new ProjectMigrationLockError("project-a");
  }
  return operation();
});

mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: { findByRef },
}));
mock.module("../../src/config", () => ({
  config: configMock,
}));
mock.module("../../src/services/migration-lock", () => ({
  ProjectMigrationLockError,
  withProjectMigrationLocks,
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    error: loggerError,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const {
  createLogicalBackup,
  listLogicalBackups,
  LogicalBackupContractError,
  restoreLogicalBackup,
} = await import(
  new URL("../../src/services/logical-backup.service.ts?logical-backup-service-test", import.meta.url).href,
);

const spawnInvocations: SpawnInvocation[] = [];
const restoredPayloads: string[] = [];
const commandExitCodes: number[] = [];
const dumpPayloads: string[] = [];
let archiveReplacementDuringRestore: { path: string; replacement: string } | null = null;

const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
  spawnInvocations.push(options);
  const exitCode = commandExitCodes.shift() ?? 0;
  const command = options.cmd[0];
  if (command === "pg_dump" && exitCode === 0 && typeof options.stdout === "number") {
    writeSync(options.stdout, dumpPayloads.shift() ?? "project logical archive");
  }
  if (command === "pg_restore"
    && options.cmd.includes("--single-transaction")
    && typeof options.stdin === "number") {
    restoredPayloads.push(readFileSync(options.stdin, "utf8"));
    if (archiveReplacementDuringRestore) {
      const replacedPath = `${archiveReplacementDuringRestore.path}.replaced`;
      renameSync(archiveReplacementDuringRestore.path, replacedPath);
      writeFileSync(archiveReplacementDuringRestore.path, archiveReplacementDuringRestore.replacement, {
        mode: 0o600,
      });
      archiveReplacementDuringRestore = null;
    }
  }
  return { exited: Promise.resolve(exitCode) } as never;
}) as typeof Bun.spawn);

function project(projectRef: string, database: string, status = "paused"): TestProject {
  return { ref: projectRef, db_name: database, status };
}

function archivePath(backupId: string): string {
  return join(logicalBackupDirectory, `.${backupId}.dump`);
}

function receiptPath(backupId: string): string {
  return join(logicalBackupDirectory, `${backupId}.json`);
}

function receiptSignature(receipt: Record<string, unknown>, signingKey: string): string {
  const { receipt_hmac_sha256: _signature, ...unsignedReceipt } = receipt;
  return createHmac("sha256", signingKey)
    .update(stableStringify(unsignedReceipt))
    .digest("hex");
}

function restoreRequest(identity: Awaited<ReturnType<typeof createLogicalBackup>>) {
  return {
    project_ref: identity.project_ref,
    backup_id: identity.backup_id,
    expected_sha256: identity.sha256,
    confirmation: [
      "RESTORE_PROJECT",
      identity.project_ref,
      identity.backup_id,
      identity.sha256,
    ].join(":"),
  };
}

function expectContractError(kind: string) {
  return expect.objectContaining({
    name: "LogicalBackupContractError",
    kind,
  });
}

describe("verified logical-full backup service", () => {
  beforeEach(async () => {
    await rm(join(logicalBackupTestRoot, "nested"), { recursive: true, force: true });
    await mkdir(logicalBackupDirectory, { recursive: true, mode: 0o700 });
    await chmod(logicalBackupDirectory, 0o700);
    projects.clear();
    projects.set("project-a", project("project-a", "tenant_database_a"));
    projects.set("project-b", project("project-b", "tenant_database_b"));
    commandExitCodes.length = 0;
    dumpPayloads.length = 0;
    restoredPayloads.length = 0;
    spawnInvocations.length = 0;
    archiveReplacementDuringRestore = null;
    migrationLocked = false;
    configMock.secretsEncryptionKey = currentSigningKey;
    configMock.legacySecretsEncryptionKey = legacySigningKey;
    findByRef.mockClear();
    withProjectMigrationLocks.mockClear();
    loggerError.mockClear();
  });

  afterAll(async () => {
    spawnSpy.mockRestore();
    await rm(logicalBackupTestRoot, { recursive: true, force: true });
    if (previousLogicalBackupDirectory === undefined) delete process.env.SUPACLOUD_LOGICAL_BACKUP_DIR;
    else process.env.SUPACLOUD_LOGICAL_BACKUP_DIR = previousLogicalBackupDirectory;
  });

  test("creates a stable receipt only after a complete custom archive is verified", async () => {
    const archivePayload = "verified archive for project a";
    dumpPayloads.push(archivePayload);

    const identity = await createLogicalBackup("project-a");
    const receipt = JSON.parse(await readFile(receiptPath(identity.backup_id), "utf8"));

    expect(identity).toEqual({
      backup_id: expect.stringMatching(/^logical-full_project-a_[a-f0-9]{32}$/),
      project_ref: "project-a",
      database: "tenant_database_a",
      kind: "logical-full",
      created_at: expect.stringMatching(/Z$/),
      completed_at: expect.stringMatching(/Z$/),
      bytes: Buffer.byteLength(archivePayload),
      sha256: createHash("sha256").update(archivePayload).digest("hex"),
    });
    expect(receipt).toMatchObject(identity);
    expect(receipt.receipt_hmac_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(logicalBackupDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(archivePath(identity.backup_id))).mode & 0o777).toBe(0o600);
    expect((await stat(receiptPath(identity.backup_id))).mode & 0o777).toBe(0o600);

    expect(spawnInvocations.map(({ cmd }) => cmd)).toEqual([
      expect.arrayContaining([
        "pg_dump", "-h", "database.internal", "-p", "6432", "-U", "postgres-admin",
        "-d", "tenant_database_a", "--format=custom", "--compress=6",
      ]),
      ["pg_restore", "--list"],
      ["pg_restore", "--list"],
    ]);
    expect(spawnInvocations[0]?.stdout).toEqual(expect.any(Number));
    expect(spawnInvocations.slice(1).every(({ stdin }) => typeof stdin === "number")).toBe(true);
    expect(JSON.stringify(spawnInvocations.map(({ cmd }) => cmd))).not.toContain(logicalBackupDirectory);
    expect(spawnInvocations[0]?.env?.PGPASSWORD).toBe("admin-secret");
    expect(JSON.stringify(spawnInvocations.map(({ cmd }) => cmd))).not.toContain("admin-secret");
  });

  test("independently reads inventory and revalidates archive bytes, digest, and catalog", async () => {
    const created = await createLogicalBackup("project-a");
    spawnInvocations.length = 0;

    await expect(listLogicalBackups("project-a")).resolves.toEqual([created]);
    expect(spawnInvocations.map(({ cmd }) => cmd)).toEqual([["pg_restore", "--list"]]);
  });

  test("fails the whole inventory when either receipt or archive was tampered", async () => {
    const receiptTamper = await createLogicalBackup("project-a");
    const serializedReceipt = JSON.parse(await readFile(receiptPath(receiptTamper.backup_id), "utf8"));
    serializedReceipt.bytes += 1;
    await writeFile(receiptPath(receiptTamper.backup_id), JSON.stringify(serializedReceipt), { mode: 0o600 });
    await expect(listLogicalBackups("project-a")).rejects.toEqual(expectContractError("unavailable"));

    await rm(logicalBackupDirectory, { recursive: true, force: true });
    await mkdir(logicalBackupDirectory, { mode: 0o700 });
    const archiveTamper = await createLogicalBackup("project-a");
    await writeFile(archivePath(archiveTamper.backup_id), "replacement archive", { mode: 0o600 });
    await expect(listLogicalBackups("project-a")).rejects.toEqual(expectContractError("unavailable"));
  });

  test("rejects archive symlinks and untrusted backup directories", async () => {
    const created = await createLogicalBackup("project-a");
    const symlinkTarget = join(logicalBackupDirectory, ".attacker-archive");
    await writeFile(symlinkTarget, "replacement archive", { mode: 0o600 });
    await rm(archivePath(created.backup_id));
    symlinkSync(symlinkTarget, archivePath(created.backup_id));
    await expect(listLogicalBackups("project-a")).rejects.toEqual(expectContractError("unavailable"));

    await rm(archivePath(created.backup_id));
    await writeFile(archivePath(created.backup_id), "replacement archive", { mode: 0o600 });
    chmodSync(logicalBackupDirectory, 0o777);
    await expect(listLogicalBackups("project-a")).rejects.toEqual(expectContractError("unavailable"));
  });

  test("creates missing trusted path segments and rejects configured-root symlinks", async () => {
    await rm(join(logicalBackupTestRoot, "nested"), { recursive: true, force: true });
    await expect(createLogicalBackup("project-a")).resolves.toMatchObject({ project_ref: "project-a" });
    expect((await stat(logicalBackupDirectory)).mode & 0o777).toBe(0o700);

    await rm(join(logicalBackupTestRoot, "nested"), { recursive: true, force: true });
    const attackerRoot = join(logicalBackupTestRoot, "attacker");
    mkdirSync(attackerRoot, { mode: 0o700 });
    symlinkSync(attackerRoot, join(logicalBackupTestRoot, "nested"));
    await expect(createLogicalBackup("project-a")).rejects.toEqual(expectContractError("unavailable"));
    expect(await readdir(attackerRoot)).toEqual([]);
  });

  test("verifies legacy signatures while signing new receipts only with the current key", async () => {
    const legacyBackup = await createLogicalBackup("project-a");
    const receipt = JSON.parse(await readFile(receiptPath(legacyBackup.backup_id), "utf8"));
    receipt.receipt_hmac_sha256 = receiptSignature(receipt, legacySigningKey);
    await writeFile(receiptPath(legacyBackup.backup_id), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    await expect(listLogicalBackups("project-a")).resolves.toEqual([legacyBackup]);

    configMock.legacySecretsEncryptionKey = "";
    await expect(listLogicalBackups("project-a")).rejects.toEqual(expectContractError("unavailable"));
    const currentBackup = await createLogicalBackup("project-b");
    const currentReceipt = JSON.parse(await readFile(receiptPath(currentBackup.backup_id), "utf8"));
    expect(currentReceipt.receipt_hmac_sha256).toBe(receiptSignature(currentReceipt, currentSigningKey));
  });

  test("cleans failed or invalid dumps without publishing success", async () => {
    commandExitCodes.push(9);
    await expect(createLogicalBackup("project-a")).rejects.toEqual(expectContractError("unavailable"));
    expect(await readdir(logicalBackupDirectory)).toEqual([]);

    commandExitCodes.push(0, 8);
    await expect(createLogicalBackup("project-a")).rejects.toEqual(expectContractError("unavailable"));
    expect(await readdir(logicalBackupDirectory)).toEqual([]);
  });

  test("restores only an exact paused-project identity with transaction failure semantics", async () => {
    const archivePayload = "restore archive project a";
    dumpPayloads.push(archivePayload);
    const created = await createLogicalBackup("project-a");
    spawnInvocations.length = 0;

    await expect(restoreLogicalBackup(restoreRequest(created))).resolves.toEqual(created);
    const restoreInvocation = spawnInvocations.find(({ cmd }) => cmd.includes("--single-transaction"));
    expect(restoreInvocation?.cmd).toEqual(expect.arrayContaining([
      "pg_restore", "-d", "tenant_database_a", "--clean", "--if-exists",
      "--exit-on-error", "--single-transaction",
    ]));
    expect(restoreInvocation?.stdin).toEqual(expect.any(Number));
    expect(restoredPayloads).toEqual([archivePayload]);

    projects.set("project-a", project("project-a", "tenant_database_a", "active"));
    spawnInvocations.length = 0;
    await expect(restoreLogicalBackup(restoreRequest(created))).rejects.toEqual(expectContractError("conflict"));
    expect(spawnInvocations).toEqual([]);
  });

  test("supports A to B to A recovery while rejecting cross-project backup identities", async () => {
    dumpPayloads.push("state A", "state B");
    const backupA = await createLogicalBackup("project-a");
    const backupB = await createLogicalBackup("project-b");
    spawnInvocations.length = 0;
    restoredPayloads.length = 0;

    const crossProjectRequest = {
      ...restoreRequest(backupA),
      project_ref: "project-b",
      confirmation: ["RESTORE_PROJECT", "project-b", backupA.backup_id, backupA.sha256].join(":"),
    };
    await expect(restoreLogicalBackup(crossProjectRequest)).rejects.toEqual(expectContractError("not_found"));
    expect(spawnInvocations).toEqual([]);

    await restoreLogicalBackup(restoreRequest(backupA));
    await restoreLogicalBackup(restoreRequest(backupB));
    await restoreLogicalBackup(restoreRequest(backupA));
    expect(restoredPayloads).toEqual(["state A", "state B", "state A"]);
    expect(spawnInvocations
      .filter(({ cmd }) => cmd.includes("--single-transaction"))
      .map(({ cmd }) => cmd[cmd.indexOf("-d") + 1])).toEqual([
        "tenant_database_a",
        "tenant_database_b",
        "tenant_database_a",
      ]);
  });

  test("rejects a backup id whose longer project ref only shares the requested prefix", async () => {
    projects.set("project", project("project", "tenant_database_prefix"));
    const longerProjectBackup = await createLogicalBackup("project-a");
    const request = {
      project_ref: "project",
      backup_id: longerProjectBackup.backup_id,
      expected_sha256: longerProjectBackup.sha256,
      confirmation: [
        "RESTORE_PROJECT",
        "project",
        longerProjectBackup.backup_id,
        longerProjectBackup.sha256,
      ].join(":"),
    };

    await expect(restoreLogicalBackup(request)).rejects.toEqual(expectContractError("not_found"));
    expect(withProjectMigrationLocks).not.toHaveBeenCalled();
  });

  test("does not report success when restore fails or archive identity changes during restore", async () => {
    const created = await createLogicalBackup("project-a");
    spawnInvocations.length = 0;
    commandExitCodes.push(0, 8);
    await expect(restoreLogicalBackup(restoreRequest(created))).rejects.toEqual(expectContractError("unavailable"));
    expect(await readFile(archivePath(created.backup_id), "utf8")).toBe("project logical archive");

    spawnInvocations.length = 0;
    archiveReplacementDuringRestore = {
      path: archivePath(created.backup_id),
      replacement: "changed while restore was running",
    };
    await expect(restoreLogicalBackup(restoreRequest(created))).rejects.toEqual(expectContractError("unavailable"));
    expect(restoredPayloads.at(-1)).toBe("project logical archive");
  });

  test("rejects missing fields, uppercase digests, wrong digests, and active database locks", async () => {
    const created = await createLogicalBackup("project-a");
    const canonicalRequest = restoreRequest(created);
    await expect(restoreLogicalBackup({
      ...canonicalRequest,
      expected_sha256: canonicalRequest.expected_sha256.toUpperCase(),
    })).rejects.toEqual(expectContractError("invalid_request"));

    const wrongSha256 = "b".repeat(64);
    await expect(restoreLogicalBackup({
      ...canonicalRequest,
      expected_sha256: wrongSha256,
      confirmation: ["RESTORE_PROJECT", "project-a", created.backup_id, wrongSha256].join(":"),
    })).rejects.toEqual(expectContractError("conflict"));

    migrationLocked = true;
    await expect(restoreLogicalBackup(canonicalRequest)).rejects.toEqual(expectContractError("conflict"));
    expect(withProjectMigrationLocks).toHaveBeenCalledWith(
      { projectRefs: ["project-a"] },
      expect.any(Function),
    );
  });
});
