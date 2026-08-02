import { $ } from 'bun';
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { logger } from "../utils/logger";
import type { BackupInfo, RestoreRequest } from '../types/backup';
import { projectRepository } from '../repositories/project.repository';
import { resolveDbName, resolveRoleName } from '../db';

const PGBACKREST_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const BACKUP_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const BACKUP_BINARY_PATTERN = /^(?:[A-Za-z0-9_.-]+|\/[A-Za-z0-9_./-]+)$/;
const BACKUP_CONFIG_PATTERN = /^\/[A-Za-z0-9_./-]+$/;
const INFO_TIMEOUT_MS = 5_000;
const BACKUP_TIMEOUT_MS = 30 * 60_000;
const PITR_TIMEOUT_MS = 30 * 60_000;
const TIMEOUT_KILL_AFTER = "--kill-after=30s";
const SETPRIV_PATH = ["/usr/bin/setpriv", "/bin/setpriv"].find(existsSync) ?? "/usr/bin/setpriv";

interface PgBackRestCommandResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export class PgBackRestUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgBackRestUnavailableError";
  }
}

export class PitrRestoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PitrRestoreUnavailableError";
  }
}

interface PgBackRestConfiguration {
  stanza: string;
  user: string;
  binary: string;
  config?: string;
}

function readPgBackRestConfiguration(environment: Record<string, string | undefined> = process.env): PgBackRestConfiguration {
  const stanza = (environment.SUPACLOUD_PGBACKREST_STANZA || "db-main").trim();
  const user = (environment.SUPACLOUD_PGBACKREST_USER || "postgres").trim();
  const binary = (environment.SUPACLOUD_PGBACKREST_BIN || "pgbackrest").trim();
  const configuredPath = environment.SUPACLOUD_PGBACKREST_CONFIG?.trim();

  if (!PGBACKREST_NAME_PATTERN.test(stanza)) throw new PgBackRestUnavailableError("Invalid SUPACLOUD_PGBACKREST_STANZA");
  if (!BACKUP_USER_PATTERN.test(user)) throw new PgBackRestUnavailableError("Invalid SUPACLOUD_PGBACKREST_USER");
  if (!BACKUP_BINARY_PATTERN.test(binary)) throw new PgBackRestUnavailableError("Invalid SUPACLOUD_PGBACKREST_BIN");
  if (configuredPath && !BACKUP_CONFIG_PATTERN.test(configuredPath)) {
    throw new PgBackRestUnavailableError("Invalid SUPACLOUD_PGBACKREST_CONFIG");
  }

  return { stanza, user, binary, config: configuredPath || undefined };
}

export function getPgBackRestStanza(environment: Record<string, string | undefined> = process.env): string {
  return readPgBackRestConfiguration(environment).stanza;
}

export function isPitrEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.SUPACLOUD_PITR_ENABLED === "true" || environment.PITR_ENABLED === "true";
}

function privilegeDropCommand(user: string, command: string[]): string[] {
  return [
    SETPRIV_PATH,
    "--reuid",
    user,
    "--regid",
    user,
    "--clear-groups",
    "--",
    ...command,
  ];
}

function pgBackRestCommand(
  pgBackRestArguments: string[],
  timeoutMs = pgBackRestArguments.includes("backup") ? BACKUP_TIMEOUT_MS : INFO_TIMEOUT_MS,
): string[] {
  const configuration = readPgBackRestConfiguration();
  const configurationArgument = configuration.config ? [`--config=${configuration.config}`] : [];
  return [
    "timeout",
    TIMEOUT_KILL_AFTER,
    String(Math.ceil(timeoutMs / 1000)),
    ...privilegeDropCommand(configuration.user, [
      configuration.binary,
      ...configurationArgument,
      `--stanza=${configuration.stanza}`,
      ...pgBackRestArguments,
    ]),
  ];
}

async function runPgBackRest(pgBackRestArguments: string[], timeoutMs: number): Promise<PgBackRestCommandResult> {
  try {
    const pgBackRestProcess = Bun.spawn(pgBackRestCommand(pgBackRestArguments, timeoutMs), { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      pgBackRestProcess.exited,
      new Response(pgBackRestProcess.stdout).text(),
      new Response(pgBackRestProcess.stderr).text(),
    ]);
    return { exitCode, stdout, timedOut: exitCode === 124 };
  } catch (error) {
    if (error instanceof PgBackRestUnavailableError) throw error;
    logger.error("[Backup] pgBackRest command could not start");
    throw new PgBackRestUnavailableError("pgBackRest command is unavailable");
  }
}

function commandFailure(
  operation: "backup inventory" | "backup",
  commandExecution: PgBackRestCommandResult,
): PgBackRestUnavailableError {
  logger.error(`[Backup] pgBackRest ${operation} failed`, {
    exitCode: commandExecution.exitCode,
    timedOut: commandExecution.timedOut,
  });
  return new PgBackRestUnavailableError(
    commandExecution.timedOut ? `pgBackRest ${operation} timed out` : `pgBackRest ${operation} failed`,
  );
}

function assertCommandSucceeded(
  operation: "backup inventory" | "backup",
  commandExecution: PgBackRestCommandResult,
): void {
  if (commandExecution.exitCode !== 0 || commandExecution.timedOut) {
    throw commandFailure(operation, commandExecution);
  }
}

function backupSizeFromMetadata(backupMetadata: Record<string, unknown> | undefined): number | null {
  const sourceSize = backupMetadata?.size;
  if (typeof sourceSize === "number" && Number.isFinite(sourceSize)) return sourceSize;
  if (sourceSize && typeof sourceSize === "object") {
    const legacyBackupSize = (sourceSize as Record<string, unknown>).backup;
    if (typeof legacyBackupSize === "number" && Number.isFinite(legacyBackupSize)) return legacyBackupSize;
  }
  const repository = backupMetadata?.repository;
  const repositorySize = repository && typeof repository === "object"
    ? (repository as Record<string, unknown>).size
    : undefined;
  return typeof repositorySize === "number" && Number.isFinite(repositorySize) ? repositorySize : null;
}

function backupInfoFromEntry(serializedBackupEntry: unknown, database?: string): BackupInfo {
  if (!serializedBackupEntry || typeof serializedBackupEntry !== "object") {
    throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
  }
  const backupEntry = serializedBackupEntry as Record<string, unknown>;
  const timestamp = backupEntry.timestamp as Record<string, unknown> | undefined;
  const backupMetadata = backupEntry.info as Record<string, unknown> | undefined;
  const id = backupEntry.label;
  const type = backupEntry.type;
  const start = timestamp?.start;
  const stop = timestamp?.stop;
  const size = backupSizeFromMetadata(backupMetadata);
  if (backupEntry.error === true
    || typeof id !== "string" || !PGBACKREST_NAME_PATTERN.test(id)
    || (type !== "full" && type !== "incr" && type !== "diff")
    || typeof start !== "number" || !Number.isFinite(start)
    || typeof stop !== "number" || !Number.isFinite(stop) || size === null) {
    throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
  }
  return { id, type, timestamp: { start, stop }, size, database };
}

function parseBackups(inventoryJson: string, database?: string): BackupInfo[] {
  try {
    const inventory = JSON.parse(inventoryJson);
    if (!Array.isArray(inventory) || inventory.length !== 1) {
      throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
    }
    const cluster = inventory[0] as Record<string, unknown>;
    if (!cluster || typeof cluster !== "object" || cluster.name !== getPgBackRestStanza()) {
      throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
    }
    if (!Array.isArray(cluster.backup)) {
      throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
    }
    const backupEntries = cluster.backup;
    assertInventoryReadable(cluster, backupEntries);
    // pgBackRest stanzas are PostgreSQL clusters, while this API is project scoped.
    return backupEntries.map((serializedBackupEntry) => backupInfoFromEntry(
      serializedBackupEntry,
      database || String(cluster.name || ""),
    ));
  } catch (error: unknown) {
    if (error instanceof PgBackRestUnavailableError) throw error;
    logger.error("[Backup] Failed to parse pgBackRest inventory", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new PgBackRestUnavailableError("Invalid pgBackRest backup inventory");
  }
}

function assertInventoryReadable(cluster: Record<string, unknown>, backupEntries: unknown[]): void {
  const stanzaStatus = cluster.status as Record<string, unknown> | undefined;
  const repositories = cluster.repo;
  const repositoryStatusesMatch = Array.isArray(repositories) && repositories.length > 0
    && repositories.every((repository) => {
      if (!repository || typeof repository !== "object") return false;
      const status = (repository as Record<string, unknown>).status;
      return Boolean(status)
        && typeof status === "object"
        && (status as Record<string, unknown>).code === stanzaStatus?.code;
    });
  const readableStatus = stanzaStatus?.code === 0
    || (stanzaStatus?.code === 2 && backupEntries.length === 0);
  if (readableStatus && repositoryStatusesMatch) return;

  logger.error("[Backup] pgBackRest inventory reported an unhealthy stanza", {
    stanza: cluster.name,
    statusCode: stanzaStatus?.code,
  });
  throw new PgBackRestUnavailableError("pgBackRest backup inventory is unavailable");
}

/**
 * List cluster backups and associate them with the requested project database.
 * The caller-provided database is deliberately not used as a pgBackRest stanza:
 * a stanza describes a PostgreSQL cluster and can contain many tenant databases.
 */
export async function listBackups(database?: string): Promise<BackupInfo[]> {
  const inventoryExecution = await runPgBackRest(["info", "--output=json"], INFO_TIMEOUT_MS);
  assertCommandSucceeded("backup inventory", inventoryExecution);
  return parseBackups(inventoryExecution.stdout, database);
}

/**
 * Complete the physical backup before reporting success, so callers never
 * mistake a failed background process for a completed recovery point.
 */
export async function createBackup(
  type: "full" | "incr" | "diff" = "incr",
): Promise<{ message: string }> {
  const result = await createBackupWithEvidence(type);
  return { message: result.message };
}

export async function createBackupWithEvidence(
  type: "full" | "incr" | "diff" = "incr",
): Promise<{ message: string; backup: BackupInfo }> {
  const beforeExecution = await runPgBackRest(["info", "--output=json"], INFO_TIMEOUT_MS);
  assertCommandSucceeded("backup inventory", beforeExecution);
  const previousBackups = parseBackups(beforeExecution.stdout);
  const previousBackupIds = new Set(previousBackups.map((backup) => backup.id));
  const hasPreviousFullBackup = previousBackups.some((backup) => backup.type === "full");

  const backupExecution = await runPgBackRest([`--type=${type}`, "backup"], BACKUP_TIMEOUT_MS);
  assertCommandSucceeded("backup", backupExecution);

  const afterExecution = await runPgBackRest(["info", "--output=json"], INFO_TIMEOUT_MS);
  assertCommandSucceeded("backup inventory", afterExecution);
  const completedBackup = assertNewCompletedBackup(
    parseBackups(afterExecution.stdout),
    previousBackupIds,
    type,
    hasPreviousFullBackup,
  );
  return { message: `${completedBackup.type} backup completed`, backup: completedBackup };
}

function assertNewCompletedBackup(
  backups: BackupInfo[],
  previousBackupIds: Set<string>,
  type: BackupInfo["type"],
  hasPreviousFullBackup: boolean,
): BackupInfo {
  const newCompletedBackups = backups.filter((backup) => (
    !previousBackupIds.has(backup.id)
    && backup.timestamp.stop > 0
  ));
  const completedBackup = newCompletedBackups.find((backup) => backup.type === type)
    ?? (!hasPreviousFullBackup && type !== "full"
      ? newCompletedBackups.find((backup) => backup.type === "full")
      : undefined);
  if (completedBackup) return completedBackup;
  logger.error("[Backup] pgBackRest completed without a new inventory record", { type });
  throw new PgBackRestUnavailableError("pgBackRest backup record is unavailable");
}

const PITR_TARGET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
let pitrRestoreInFlight = false;

export async function restore(request: RestoreRequest): Promise<{ message: string }> {
  if (!PITR_TARGET_PATTERN.test(request.target)) {
    throw new Error("Invalid PITR target");
  }
  if (pitrRestoreInFlight) {
    throw new PitrRestoreUnavailableError("A PITR restore is already in progress");
  }
  pitrRestoreInFlight = true;

  try {
    let exitCode: number;
    try {
      const restoreProcess = Bun.spawn([
        "timeout",
        TIMEOUT_KILL_AFTER,
        String(Math.ceil(PITR_TIMEOUT_MS / 1000)),
        ...privilegeDropCommand("postgres", [
          "pig",
          "pitr",
          "-s",
          getPgBackRestStanza(),
          "-t",
          request.target,
          "-y",
        ]),
      ], { stdout: "pipe", stderr: "pipe" });
      [exitCode] = await Promise.all([
        restoreProcess.exited,
        new Response(restoreProcess.stdout).text(),
        new Response(restoreProcess.stderr).text(),
      ]);
    } catch {
      logger.error("[Backup] PITR restore command could not start");
      throw new PitrRestoreUnavailableError("PITR restore command is unavailable");
    }

    if (exitCode !== 0) {
      logger.error("[Backup] PITR restore failed", { exitCode, timedOut: exitCode === 124 });
      throw new PitrRestoreUnavailableError(exitCode === 124 ? "PITR restore timed out" : "PITR restore failed");
    }
    return { message: `Point-in-time recovery (PITR) completed, target: ${request.target}` };
  } finally {
    pitrRestoreInFlight = false;
  }
}

const LOGICAL_BACKUP_DIR = process.env.SUPACLOUD_LOGICAL_BACKUP_DIR || "/tmp/supacloud-backups";
const LOGICAL_BACKUP_FILE_PATTERN = /^backup_[A-Za-z0-9_-]{1,64}_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sql\.gz$/;

async function ensureLogicalBackupDir(): Promise<string> {
        const baseDir = resolve(LOGICAL_BACKUP_DIR);
        await mkdir(baseDir, { recursive: true, mode: 0o700 });
        return baseDir;
    }

async function resolveLogicalBackupPath(filename: string): Promise<string> {
        if (filename !== basename(filename) || !LOGICAL_BACKUP_FILE_PATTERN.test(filename)) {
            throw new Error("Invalid backup id");
        }
        const baseDir = await ensureLogicalBackupDir();
        const fullPath = resolve(baseDir, filename);
        if (!fullPath.startsWith(`${baseDir}/`)) {
            throw new Error("Invalid backup path");
        }
        return fullPath;
    }

    /**
     * Execute logical backup per tenant level (pg_dump)
     * Export dedicated data and upload to corresponding S3 bucket
     */
export async function createLogicalBackup(projectRef: string): Promise<{ success: boolean; message: string; file?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${projectRef}_${timestamp}.sql.gz`;
        const backupPath = await resolveLogicalBackupPath(filename);

        try {
            // Use tenant role, export as Custom archive format with default gzip compression
            const tenantHost = `localhost:5432`;
            const tenantDb = await resolveDbName(projectRef);
            const tenantUser = resolveRoleName(projectRef);

            logger.info(`[LogicalBackup] Starting dump for ${projectRef} -> ${backupPath}`);
            await $`PGPASSWORD=${project.db_password} pg_dump -h localhost -p 5432 -U ${tenantUser} -d ${tenantDb} -F c -Z 6 -f ${backupPath}`.quiet();

            // Try to upload to tenant's hidden backup prefix via AWS CLI (MinIO/Garage compatible)
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp ${backupPath} s3://${project.s3_bucket}/_backups/${filename}`.quiet();
                    logger.info(`[LogicalBackup] Uploaded ${filename} to S3.`);
                    await $`rm -f ${backupPath}`.quiet(); // Cleanup local after successful upload
                } catch (uploadErr: unknown) {
                    logger.warn('[LogicalBackup] S3 Upload failed (Ensure awscli is installed). Kept local copy at', backupPath);
                }
            }

            return { success: true, message: "Logical backup completed", file: filename };
        } catch (err: unknown) {
            logger.error("[LogicalBackup] failed:", { error: err instanceof Error ? err.message : String(err) });
            return { success: false, message: "Logical backup failed: " + (err instanceof Error ? err.message : String(err)) };
        }
    }

    /**
     * Execute logical restore per tenant level (pg_restore)
     */
export async function restoreLogicalBackup(projectRef: string, backupId: string): Promise<{ success: boolean; message: string }> {
        let backupPath: string;
        try {
            backupPath = await resolveLogicalBackupPath(backupId);
        } catch {
            return { success: false, message: "Invalid backup id" };
        }

        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        try {
            // Try downloading from S3 first
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp s3://${project.s3_bucket}/_backups/${backupId} ${backupPath}`.quiet();
                    logger.info(`[LogicalBackup] Downloaded ${backupId} from S3.`);
                } catch (dlErr: unknown) {
                    logger.warn('[LogicalBackup] Could not download from S3, assuming local file exists.');
                }
            }

            // Check file exists
            const fileExists = await $`test -f ${backupPath}`.nothrow();
            if (fileExists.exitCode !== 0) {
                return { success: false, message: "Backup file not found: " + backupId };
            }

            // Execute pg_restore (force clean old objects and complete in single transaction)
            const tenantDb = await resolveDbName(projectRef);
            const tenantUser = resolveRoleName(projectRef);
            logger.info(`[LogicalBackup] Starting restore for ${projectRef} from ${backupPath}`);

            await $`PGPASSWORD=${project.db_password} pg_restore -h localhost -p 5432 -U ${tenantUser} -d ${tenantDb} -c -1 ${backupPath}`.quiet();

            logger.info(`[LogicalBackup] Restore complete for ${projectRef}`);
            return { success: true, message: "Logical restore completed successfully" };
        } catch (err: unknown) {
            logger.error("[LogicalBackup] Restore failed:", { error: err instanceof Error ? err.message : String(err) });
            return { success: false, message: "Restore process error: " + (err instanceof Error ? err.message : String(err)) };
        } finally {
            // Cleanup local temp file
            await $`rm -f ${backupPath}`.nothrow().quiet();
        }
    }
