import { randomUUID } from "node:crypto";
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MANAGED_CONFIG_PREFIX = "# Managed by SupaCloud Management API.";
const DB_POOL_LINE_PATTERN = /^(\s*db-pool\s*=\s*)(\d+)(\s*(?:#.*)?)$/gm;
export const POSTGREST_POOL_RETRY_BACKOFF_MS = 60 * 60 * 1000;

interface PostgrestPoolReconcileRequest {
  configPath: string;
  desiredPool: number;
  projectStatus: string;
  desiredState: "running" | "stopped";
  restartAndWait: () => Promise<void>;
}

interface PostgrestConfigSnapshot {
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

export type PostgrestPoolReconcileResult =
  | { state: "skipped" | "unchanged" | "updated" }
  | {
      state: "rolled_back";
      error: "POSTGREST_POOL_UPDATE_ROLLED_BACK";
      cause: unknown;
    };

export class PostgrestPoolReconcileError extends AggregateError {
  readonly code = "POSTGREST_POOL_ROLLBACK_FAILED";

  constructor(updateError: unknown, rollbackError: unknown) {
    super(
      [updateError, rollbackError],
      "PostgREST pool update failed and the previous configuration could not be restored healthy",
    );
    this.name = "PostgrestPoolReconcileError";
  }
}

export class PostgrestPoolMigrationGate {
  private failedDesiredPool: number | null = null;
  private retryAt = 0;
  private sweepBlocked = false;

  constructor(
    private readonly retryBackoffMs = POSTGREST_POOL_RETRY_BACKOFF_MS,
    private readonly now: () => number = Date.now,
  ) {}

  beginSweep(desiredPool: number): boolean {
    assertDesiredPool(desiredPool);
    if (this.failedDesiredPool !== desiredPool) {
      this.failedDesiredPool = null;
      this.retryAt = 0;
    }
    this.sweepBlocked = this.failedDesiredPool === desiredPool && this.now() < this.retryAt;
    return !this.sweepBlocked;
  }

  recordFailure(desiredPool: number): void {
    assertDesiredPool(desiredPool);
    this.failedDesiredPool = desiredPool;
    this.retryAt = this.now() + this.retryBackoffMs;
    this.sweepBlocked = true;
  }

  canAttempt(): boolean {
    return !this.sweepBlocked;
  }
}

function assertDesiredPool(desiredPool: number): void {
  if (!Number.isInteger(desiredPool) || desiredPool <= 0) {
    throw new Error("PostgREST database pool must be a positive integer");
  }
}

export function renderManagedPostgrestDbPool(
  content: string,
  desiredPool: number,
): string | null {
  assertDesiredPool(desiredPool);
  if (!content.startsWith(MANAGED_CONFIG_PREFIX)) return null;
  const matches = [...content.matchAll(DB_POOL_LINE_PATTERN)];
  if (matches.length !== 1) {
    throw new Error("Managed PostgREST config must contain exactly one db-pool setting");
  }
  const [match] = matches;
  if (Number(match[2]) === desiredPool) return null;
  const start = match.index;
  const replacement = `${match[1]}${desiredPool}${match[3]}`;
  return `${content.slice(0, start)}${replacement}${content.slice(start + match[0].length)}`;
}

async function readConfigSnapshot(configPath: string): Promise<PostgrestConfigSnapshot> {
  const [content, metadata] = await Promise.all([
    readFile(configPath, "utf8"),
    stat(configPath),
  ]);
  return {
    content,
    mode: metadata.mode & 0o7777,
    uid: metadata.uid,
    gid: metadata.gid,
  };
}

async function writeConfigSnapshot(
  configPath: string,
  snapshot: PostgrestConfigSnapshot,
): Promise<void> {
  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${randomUUID()}.tmp`,
  );
  let writeError: unknown;
  try {
    await writeFile(temporaryPath, snapshot.content, {
      encoding: "utf8",
      flag: "wx",
      mode: snapshot.mode,
    });
    await chown(temporaryPath, snapshot.uid, snapshot.gid);
    await chmod(temporaryPath, snapshot.mode);
    await rename(temporaryPath, configPath);
  } catch (error: unknown) {
    writeError = error;
  }
  let cleanupError: unknown;
  try {
    await rm(temporaryPath, { force: true });
  } catch (error: unknown) {
    cleanupError = error;
  }
  if (writeError && cleanupError) {
    throw new AggregateError(
      [writeError, cleanupError],
      "PostgREST config write and temporary file cleanup both failed",
    );
  }
  if (writeError) throw writeError;
  if (cleanupError) throw cleanupError;
}

async function assertCurrentConfig(
  configPath: string,
  expectedContent: string,
): Promise<void> {
  const currentContent = await readFile(configPath, "utf8");
  if (currentContent !== expectedContent) {
    throw new Error("PostgREST config changed concurrently; refusing to overwrite it during rollback");
  }
}

function isEligible(request: PostgrestPoolReconcileRequest): boolean {
  return request.projectStatus === "active" && request.desiredState === "running";
}

export async function reconcileManagedPostgrestPool(
  request: PostgrestPoolReconcileRequest,
): Promise<PostgrestPoolReconcileResult> {
  if (!isEligible(request)) return { state: "skipped" };
  const original = await readConfigSnapshot(request.configPath);
  const candidateContent = renderManagedPostgrestDbPool(
    original.content,
    request.desiredPool,
  );
  if (candidateContent === null) return { state: "unchanged" };

  await writeConfigSnapshot(request.configPath, {
    ...original,
    content: candidateContent,
  });
  try {
    await request.restartAndWait();
    return { state: "updated" };
  } catch (updateError: unknown) {
    try {
      await assertCurrentConfig(request.configPath, candidateContent);
      await writeConfigSnapshot(request.configPath, original);
      await request.restartAndWait();
      return {
        state: "rolled_back",
        error: "POSTGREST_POOL_UPDATE_ROLLED_BACK",
        cause: updateError,
      };
    } catch (rollbackError: unknown) {
      throw new PostgrestPoolReconcileError(updateError, rollbackError);
    }
  }
}
