import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  controlPlaneDatabaseFingerprint,
  inspectControlPlaneDatabaseIdentity,
  parseExpectedControlPlaneDatabaseSnapshot,
} from "./db/control-plane-database-identity";
import { hasSecretEncryptionCheckpoint } from "./db/secret-key-migration";

const BACKUP_ROOT = "/var/lib/supacloud/backups/control-plane-upgrades";
const BACKUP_ID_PATTERN = /^control-plane-\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_LIMIT = 5;
const BACKUP_USER = "postgres";
const COMMAND_TIMEOUT_SECONDS = 1800;
const MAX_RECEIPT_BYTES = 8 * 1024;
const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/;
const SETPRIV_PATH = ["/usr/bin/setpriv", "/bin/setpriv"].find(existsSync) ?? "/usr/bin/setpriv";
const ID_PATH = ["/usr/bin/id", "/bin/id"].find(existsSync) ?? "/usr/bin/id";
const PG_DUMP_PATH = ["/usr/bin/pg_dump", "/usr/local/bin/pg_dump"].find(existsSync) ?? "/usr/bin/pg_dump";
const PG_RESTORE_PATH = ["/usr/bin/pg_restore", "/usr/local/bin/pg_restore"].find(existsSync) ?? "/usr/bin/pg_restore";
const TIMEOUT_PATH = ["/usr/bin/timeout", "/bin/timeout"].find(existsSync) ?? "/usr/bin/timeout";

export type ControlPlaneMigrationCandidates = {
  deprecated_webhook_secrets: number;
  legacy_deployment_history_rows: number;
  legacy_project_config_rows: number;
  opaque_key_backfill_projects: number;
  stored_secret_values: number;
};

export type ControlPlaneUpgradeSafetyEvidence = {
  schema: "supacloud.control-plane-upgrade-safety.v1";
  backup_id: string;
  backup_directory: string;
  bytes: number;
  candidate_counts: ControlPlaneMigrationCandidates;
  completed_at: string;
  current_key_checkpoint_present: boolean;
  sha256: string;
};

type DatabaseTarget = {
  database: string;
  hostname: string;
  password: string;
  port: string;
  username: string;
};

type CommandRequest = {
  args: string[];
  env?: Record<string, string | undefined>;
  stdin?: number;
  stdout?: number;
};

type ControlPlaneBackupOperations = {
  backupRoot: string;
  identity: (user: string) => Promise<{ gid: number; uid: number }>;
  now: () => Date;
  randomId: () => string;
  remove?: (directory: string) => void;
  run: (request: CommandRequest) => Promise<number>;
};

type ControlPlaneSafetyOperations = {
  backup: (
    target: DatabaseTarget,
    inspection: ControlPlaneInspection,
  ) => Promise<ControlPlaneUpgradeSafetyEvidence>;
  withInspection: <T>(
    databaseUrl: string,
    currentKey: string,
    operation: (inspection: ControlPlaneInspection) => Promise<T>,
  ) => Promise<T>;
};

export type ControlPlaneUpgradeSafetyLease = {
  databaseFingerprint: string;
  evidence: ControlPlaneUpgradeSafetyEvidence;
  snapshotId: string;
};

type ControlPlaneInspection = {
  candidateCounts: ControlPlaneMigrationCandidates;
  checkpointPresent: boolean;
  databaseFingerprint: string;
  databaseTargetFingerprint: string;
  snapshotId: string;
};

function databaseTarget(databaseUrl: string): DatabaseTarget {
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Control-plane backup requires a PostgreSQL DATABASE_URL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const username = decodeURIComponent(parsed.username);
  const port = parsed.port || "5432";
  if (!POSTGRES_IDENTIFIER.test(database)
    || !POSTGRES_IDENTIFIER.test(username)
    || !parsed.hostname
    || !/^\d{1,5}$/.test(port)
    || Number(port) < 1
    || Number(port) > 65_535
    || parsed.search
    || parsed.hash) {
    throw new Error("Control-plane backup DATABASE_URL is incomplete");
  }
  return {
    database,
    hostname: parsed.hostname,
    password: decodeURIComponent(parsed.password),
    port,
    username,
  };
}

function databaseTargetFingerprint(target: DatabaseTarget): string {
  return createHash("sha256")
    .update([target.hostname, target.port, target.database].join("\0"))
    .digest("hex");
}

async function tableExists(database: SQL, table: string): Promise<boolean> {
  const [row] = await database`
    SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present
  `;
  return row?.present === true;
}

async function legacyDeploymentRows(database: SQL): Promise<number> {
  const [legacy] = await database`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'deployment_history'
        AND column_name = 'project_ref'
    ) AS present
  `;
  if (legacy?.present !== true) return 0;
  const [count] = await database`SELECT COUNT(*)::int AS count FROM deployment_history`;
  return Number(count?.count || 0);
}

async function projectCandidateCounts(database: SQL) {
  const [counts] = await database`
    SELECT
      COUNT(*) FILTER (
        WHERE config ? 'webhooks'
           OR config #> '{auth,external}' IS NOT NULL
           OR config #> '{auth,hooks}' IS NOT NULL
           OR config #> '{auth,experimental,providers_with_own_linking_domain}' IS NOT NULL
           OR config #> '{auth,security_captcha_secret}' IS NOT NULL
      )::int AS legacy_config,
      COUNT(*) FILTER (
        WHERE publishable_key IS NULL
           OR secret_key_hash IS NULL
           OR secret_key_encrypted IS NULL
      )::int AS opaque_keys,
      COUNT(*) FILTER (WHERE db_password_encrypted IS NOT NULL)::int
        + COUNT(*) FILTER (WHERE jwt_secret_encrypted IS NOT NULL)::int
        + COUNT(*) FILTER (WHERE service_role_key_encrypted IS NOT NULL)::int
        + COUNT(*) FILTER (WHERE secret_key_encrypted IS NOT NULL)::int
        + COUNT(*) FILTER (WHERE s3_secret_key_encrypted IS NOT NULL)::int AS project_secrets
    FROM projects
  `;
  return {
    legacyConfig: Number(counts?.legacy_config || 0),
    opaqueKeys: Number(counts?.opaque_keys || 0),
    projectSecrets: Number(counts?.project_secrets || 0),
  };
}

async function optionalTableCount(database: SQL, table: string, expression = "COUNT(*)"): Promise<number> {
  if (!(await tableExists(database, table))) return 0;
  const allowed = new Map([
    ["platform_settings", "COUNT(*) FILTER (WHERE is_secret = true)"],
    ["project_control_secrets", "COUNT(*)"],
    ["project_secrets", "COUNT(*)"],
    ["project_tasks", "COUNT(*) FILTER (WHERE payload ? 'auth')"],
    ["project_webhooks", "COUNT(*) FILTER (WHERE secret_encrypted IS NOT NULL OR previous_secret_encrypted IS NOT NULL)"],
  ]);
  if (allowed.get(table) !== expression) throw new Error("Unsupported control-plane preflight query");
  const [count] = await database.unsafe(`SELECT (${expression})::int AS count FROM ${table}`);
  return Number(count?.count || 0);
}

async function storedSecretCount(database: SQL, projectSecrets: number): Promise<number> {
  const counts = await Promise.all([
    optionalTableCount(database, "project_secrets"),
    optionalTableCount(database, "project_control_secrets"),
    optionalTableCount(database, "platform_settings", "COUNT(*) FILTER (WHERE is_secret = true)"),
    optionalTableCount(database, "project_tasks", "COUNT(*) FILTER (WHERE payload ? 'auth')"),
    optionalTableCount(
      database,
      "project_webhooks",
      "COUNT(*) FILTER (WHERE secret_encrypted IS NOT NULL OR previous_secret_encrypted IS NOT NULL)",
    ),
  ]);
  return projectSecrets + counts.reduce((total, count) => total + count, 0);
}

async function inspectControlPlane(
  database: SQL,
  target: DatabaseTarget,
  currentKey: string,
): Promise<ControlPlaneInspection> {
  const identity = await inspectControlPlaneDatabaseIdentity(database);
  const [controlPlane] = await database`
    SELECT to_regclass('public.projects') IS NOT NULL AS projects_table_exists
  `;
  if (identity.databaseName !== target.database || controlPlane?.projects_table_exists !== true) {
    throw new Error("DATABASE_URL is not the SupaCloud Management control-plane database");
  }
  const [collision] = await database`
    SELECT COUNT(*)::int AS count FROM projects WHERE db_name = current_database()
  `;
  if (Number(collision?.count || 0) !== 0) {
    throw new Error("DATABASE_URL resolves to a registered tenant database");
  }
  const projects = await projectCandidateCounts(database);
  const [snapshot] = await database`SELECT pg_export_snapshot() AS snapshot_id`;
  if (typeof snapshot?.snapshot_id !== "string") {
    throw new Error("Control-plane database did not export a valid backup snapshot");
  }
  const snapshotId = parseExpectedControlPlaneDatabaseSnapshot(snapshot.snapshot_id);
  return {
    candidateCounts: {
      deprecated_webhook_secrets: await optionalTableCount(
        database,
        "project_webhooks",
        "COUNT(*) FILTER (WHERE secret_encrypted IS NOT NULL OR previous_secret_encrypted IS NOT NULL)",
      ),
      legacy_deployment_history_rows: await legacyDeploymentRows(database),
      legacy_project_config_rows: projects.legacyConfig,
      opaque_key_backfill_projects: projects.opaqueKeys,
      stored_secret_values: await storedSecretCount(database, projects.projectSecrets),
    },
    checkpointPresent: await hasSecretEncryptionCheckpoint(database, currentKey),
    databaseFingerprint: controlPlaneDatabaseFingerprint(identity),
    databaseTargetFingerprint: databaseTargetFingerprint(target),
    snapshotId,
  };
}

async function withControlPlaneInspection<T>(
  databaseUrl: string,
  currentKey: string,
  operation: (inspection: ControlPlaneInspection) => Promise<T>,
): Promise<T> {
  const target = databaseTarget(databaseUrl);
  const database = new SQL({ url: databaseUrl, database: target.database, max: 1 });
  try {
    return await database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return operation(await inspectControlPlane(transaction, target, currentKey));
    });
  } finally {
    await database.close();
  }
}

async function commandIdentity(user: string): Promise<{ gid: number; uid: number }> {
  const values = await Promise.all(["-u", "-g"].map(async (flag) => {
    const process = Bun.spawn([TIMEOUT_PATH, "5", ID_PATH, flag, user], {
      env: {}, stdout: "pipe", stderr: "ignore",
    });
    const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
    const numericIdentity = stdout.trim();
    if (exitCode !== 0 || !/^\d+$/.test(numericIdentity)) {
      throw new Error("Control-plane backup account lookup failed");
    }
    return Number(numericIdentity);
  }));
  return { uid: values[0]!, gid: values[1]! };
}

async function runCommand(request: CommandRequest): Promise<number> {
  const childProcess = Bun.spawn(request.args, {
    env: request.env ?? {},
    stdin: request.stdin ?? "ignore",
    stdout: request.stdout ?? "ignore",
    stderr: "ignore",
  });
  return childProcess.exited;
}

function defaultBackupOperations(): ControlPlaneBackupOperations {
  return {
    backupRoot: BACKUP_ROOT,
    identity: commandIdentity,
    now: () => new Date(),
    randomId: randomUUID,
    run: runCommand,
  };
}

function assertPrivateDirectory(directory: string, expectedUid: number): void {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
    throw new Error("Control-plane backup directory is not a trusted directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("Control-plane backup directory permissions must be 0700");
  }
}

function createBackupDirectory(operations: ControlPlaneBackupOperations, backupId: string): string {
  const currentUid = process.getuid?.() ?? 0;
  if (!existsSync(operations.backupRoot)) mkdirSync(operations.backupRoot, { mode: 0o700, recursive: true });
  assertPrivateDirectory(operations.backupRoot, currentUid);
  const backupDirectory = join(operations.backupRoot, backupId);
  mkdirSync(backupDirectory, { mode: 0o700 });
  assertPrivateDirectory(backupDirectory, currentUid);
  return backupDirectory;
}

function dumpArguments(target: DatabaseTarget, inspection: ControlPlaneInspection, uid: number, gid: number): string[] {
  return [
    TIMEOUT_PATH, "--kill-after=30s", String(COMMAND_TIMEOUT_SECONDS),
    SETPRIV_PATH, "--reuid", String(uid), "--regid", String(gid), "--init-groups", "--",
    PG_DUMP_PATH, "--host", target.hostname, "--port", target.port, "--username", target.username,
    "--dbname", target.database, "--format=custom", "--compress=6", "--snapshot", inspection.snapshotId,
  ];
}

function verifyArguments(): string[] {
  return [TIMEOUT_PATH, "60", PG_RESTORE_PATH, "--list"];
}

function fileSha256(descriptor: number, bytes: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, bytes));
  let position = 0;
  while (position < bytes) {
    const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (bytesRead === 0) throw new Error("Control-plane backup archive ended during hashing");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

function syncPath(filePath: string, directory = false): void {
  const flags = directory
    ? fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  const descriptor = openSync(filePath, flags);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertBackupArchive(metadata: Stats, expectedUid: number, expectedBytes?: number): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== expectedUid
    || (metadata.mode & 0o777) !== 0o600
    || (expectedBytes !== undefined && metadata.size !== expectedBytes)) {
    throw new Error("Control-plane backup archive is not a trusted regular file");
  }
}

function reserveBackupArchive(archivePath: string): number {
  const descriptor = openSync(
    archivePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    assertBackupArchive(fstatSync(descriptor), process.getuid?.() ?? 0, 0);
    return descriptor;
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function openBackupArchive(archivePath: string, expectedUid: number): number {
  const pathMetadata = lstatSync(archivePath);
  assertBackupArchive(pathMetadata, expectedUid);
  const descriptor = openSync(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const descriptorMetadata = fstatSync(descriptor);
    assertBackupArchive(descriptorMetadata, expectedUid);
    if (descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino) {
      throw new Error("Control-plane backup archive identity changed");
    }
    if (descriptorMetadata.size <= 0) throw new Error("Control-plane backup archive is empty");
    return descriptor;
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function assertStableBackupArchive(archivePath: string, descriptor: number): void {
  const opened = fstatSync(descriptor);
  const current = lstatSync(archivePath);
  assertBackupArchive(opened, process.getuid?.() ?? 0);
  assertBackupArchive(current, process.getuid?.() ?? 0);
  if (opened.dev !== current.dev || opened.ino !== current.ino || opened.size !== current.size
    || opened.mtimeMs !== current.mtimeMs || opened.ctimeMs !== current.ctimeMs) {
    throw new Error("Control-plane backup archive changed during verification");
  }
}

function completedTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function retentionCandidates(root: string, currentId: string): string[] {
  const backupIds = readdirSync(root).filter((entry) => BACKUP_ID_PATTERN.test(entry)).sort().reverse();
  const retainedIds = new Set([
    currentId,
    ...backupIds.filter((backupId) => backupId !== currentId).slice(0, BACKUP_LIMIT - 1),
  ]);
  return backupIds.filter((backupId) => !retainedIds.has(backupId));
}

function storedReceipt(directory: string, backupId: string): { bytes: number; sha256: string } {
  const currentUid = process.getuid?.() ?? 0;
  const receiptPath = join(directory, "receipt.json");
  const pathMetadata = lstatSync(receiptPath);
  assertBackupArchive(pathMetadata, currentUid);
  if (pathMetadata.size <= 0 || pathMetadata.size > MAX_RECEIPT_BYTES) {
    throw new Error("Control-plane backup receipt size is invalid");
  }
  const descriptor = openSync(receiptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    assertBackupArchive(opened, currentUid, pathMetadata.size);
    if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
      throw new Error("Control-plane backup receipt identity changed");
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    const current = lstatSync(receiptPath);
    assertBackupArchive(current, currentUid, opened.size);
    if (current.dev !== opened.dev || current.ino !== opened.ino
      || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error("Control-plane backup receipt changed while it was read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Control-plane backup receipt is invalid");
    }
    const receipt = parsed as Record<string, unknown>;
    if (receipt.schema !== "supacloud.control-plane-upgrade-safety.v1"
      || receipt.backup_id !== backupId
      || receipt.backup_directory !== directory
      || !Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) <= 0
      || typeof receipt.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.sha256)) {
      throw new Error("Control-plane backup receipt does not match its directory");
    }
    return { bytes: Number(receipt.bytes), sha256: receipt.sha256 };
  } finally {
    closeSync(descriptor);
  }
}

async function assertTrustedStoredBackup(
  root: string,
  backupId: string,
  operations: ControlPlaneBackupOperations,
): Promise<void> {
  const directory = join(root, backupId);
  assertPrivateDirectory(directory, process.getuid?.() ?? 0);
  if (readdirSync(directory).sort().join("\0") !== "control-plane.dump\0receipt.json") {
    throw new Error("Control-plane backup directory contents are not trusted");
  }
  const receipt = storedReceipt(directory, backupId);
  const archivePath = join(directory, "control-plane.dump");
  const descriptor = openBackupArchive(archivePath, process.getuid?.() ?? 0);
  try {
    if (fstatSync(descriptor).size !== receipt.bytes || fileSha256(descriptor, receipt.bytes) !== receipt.sha256) {
      throw new Error("Control-plane backup archive does not match its receipt");
    }
    if (await operations.run({ args: verifyArguments(), stdin: descriptor }) !== 0) {
      throw new Error("Control-plane retained backup catalog is invalid");
    }
    assertStableBackupArchive(archivePath, descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function retainRecentBackups(
  operations: ControlPlaneBackupOperations,
  currentId: string,
): Promise<void> {
  const candidates = retentionCandidates(operations.backupRoot, currentId);
  for (const backupId of candidates) {
    await assertTrustedStoredBackup(operations.backupRoot, backupId, operations);
  }
  for (const backupId of candidates) {
    const directory = join(operations.backupRoot, backupId);
    if (operations.remove) operations.remove(directory);
    else rmSync(directory, { force: true, recursive: true });
  }
}

async function createControlPlaneBackup(
  target: DatabaseTarget,
  inspection: ControlPlaneInspection,
  operations: ControlPlaneBackupOperations = defaultBackupOperations(),
): Promise<ControlPlaneUpgradeSafetyEvidence> {
  const backupId = `control-plane-${completedTimestamp(operations.now())}-${operations.randomId()}`;
  const backupDirectory = createBackupDirectory(operations, backupId);
  const archivePath = join(backupDirectory, "control-plane.dump");
  let durableBackup = false;
  try {
    const backupIdentity = await operations.identity(BACKUP_USER);
    const archiveDescriptor = reserveBackupArchive(archivePath);
    let bytes: number;
    let sha256: string;
    try {
      if (await operations.run({
        args: dumpArguments(target, inspection, backupIdentity.uid, backupIdentity.gid),
        env: { PGPASSWORD: target.password },
        stdout: archiveDescriptor,
      }) !== 0) throw new Error("Control-plane pg_dump failed");
      fsyncSync(archiveDescriptor);
      assertStableBackupArchive(archivePath, archiveDescriptor);
      bytes = fstatSync(archiveDescriptor).size;
      if (bytes <= 0) throw new Error("Control-plane backup archive is empty");
      const verificationDescriptor = openBackupArchive(archivePath, process.getuid?.() ?? 0);
      try {
        if (await operations.run({ args: verifyArguments(), stdin: verificationDescriptor }) !== 0) {
          throw new Error("Control-plane backup archive verification failed");
        }
        assertStableBackupArchive(archivePath, verificationDescriptor);
      } finally {
        closeSync(verificationDescriptor);
      }
      sha256 = fileSha256(archiveDescriptor, bytes);
      assertStableBackupArchive(archivePath, archiveDescriptor);
    } finally {
      closeSync(archiveDescriptor);
    }
    const evidence: ControlPlaneUpgradeSafetyEvidence = {
      schema: "supacloud.control-plane-upgrade-safety.v1",
      backup_id: backupId,
      backup_directory: backupDirectory,
      bytes,
      candidate_counts: inspection.candidateCounts,
      completed_at: operations.now().toISOString(),
      current_key_checkpoint_present: inspection.checkpointPresent,
      sha256,
    };
    const receiptPath = join(backupDirectory, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(evidence)}\n`, { flag: "wx", mode: 0o600 });
    syncPath(receiptPath);
    syncPath(backupDirectory, true);
    syncPath(operations.backupRoot, true);
    durableBackup = true;
    await retainRecentBackups(operations, backupId);
    syncPath(operations.backupRoot, true);
    return evidence;
  } catch (error: unknown) {
    if (!durableBackup) rmSync(backupDirectory, { force: true, recursive: true });
    throw error;
  }
}

function defaultSafetyOperations(): ControlPlaneSafetyOperations {
  return {
    backup: (target, inspection) => createControlPlaneBackup(target, inspection),
    withInspection: withControlPlaneInspection,
  };
}

export async function prepareControlPlaneUpgradeSafety(
  databaseUrl: string,
  currentKey: string,
  operations: ControlPlaneSafetyOperations = defaultSafetyOperations(),
): Promise<ControlPlaneUpgradeSafetyEvidence> {
  return withControlPlaneUpgradeSafety(databaseUrl, currentKey, async () => {}, operations);
}

export async function withControlPlaneUpgradeSafety(
  databaseUrl: string,
  currentKey: string,
  operation: (lease: ControlPlaneUpgradeSafetyLease) => Promise<void>,
  operations: ControlPlaneSafetyOperations = defaultSafetyOperations(),
): Promise<ControlPlaneUpgradeSafetyEvidence> {
  const target = databaseTarget(databaseUrl);
  return operations.withInspection(databaseUrl, currentKey, async (inspection) => {
    if (inspection.databaseTargetFingerprint !== databaseTargetFingerprint(target)) {
      throw new Error("Control-plane database identity changed before backup");
    }
    const evidence = await operations.backup(target, inspection);
    await operation({
      databaseFingerprint: inspection.databaseFingerprint,
      evidence,
      snapshotId: inspection.snapshotId,
    });
    return evidence;
  });
}

export const controlPlaneUpgradeSafetyInternals = {
  createControlPlaneBackup,
  databaseTargetFingerprint,
  databaseTarget,
  dumpArguments,
  verifyArguments,
};
