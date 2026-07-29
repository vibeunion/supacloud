import { randomUUID } from "node:crypto";
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MANAGED_CONFIG_PREFIX = "# Managed by SupaCloud Management API.";
const DB_POOL_LINE_PATTERN = /^(\s*db-pool\s*=\s*)(\d+)(\s*(?:#.*)?)$/gm;
const CONFIG_ASSIGNMENT_PATTERN = /^([a-z][a-z0-9-]*)\s*=\s*(.+)$/;
const CANONICAL_INTEGER_PATTERN = /^[1-9]\d*$/;
const LEGACY_OPTIONAL_CONFIG_KEY = "jwt-aud";
const LEGACY_REQUIRED_CONFIG_KEYS = new Set([
  "db-uri",
  "db-schemas",
  "db-extra-search-path",
  "db-anon-role",
  "jwt-secret",
  "server-port",
  "server-host",
  "db-pool",
  "db-pool-acquisition-timeout",
  "log-level",
  "openapi-mode",
  "openapi-server-proxy-uri",
  "db-pre-request",
  "db-max-rows",
  "server-cors-allowed-origins",
  "db-channel",
]);
const LEGACY_DYNAMIC_STRING_KEYS = [
  "db-uri",
  "db-schemas",
  "jwt-secret",
  "openapi-server-proxy-uri",
  "server-cors-allowed-origins",
  LEGACY_OPTIONAL_CONFIG_KEY,
] as const;
const LEGACY_STATIC_CONFIG_VALUES = new Map([
  ["db-extra-search-path", '"public, extensions, auth"'],
  ["db-anon-role", '"anon"'],
  ["server-host", '"0.0.0.0"'],
  ["db-pool-acquisition-timeout", "10"],
  ["log-level", '"warn"'],
  ["openapi-mode", '"follow-privileges"'],
  ["db-pre-request", '"public.set_request_context"'],
  ["db-max-rows", "1000"],
]);
export const POSTGREST_POOL_RETRY_BACKOFF_MS = 60 * 60 * 1000;

interface PostgrestPoolReconcileRequest {
  configPath: string;
  projectRef: string;
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

function tomlValueWithoutInlineComment(candidate: string): string {
  let insideString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (escaped) {
      escaped = false;
    } else if (insideString && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      insideString = !insideString;
    } else if (!insideString && character === "#") {
      return candidate.slice(0, index).trimEnd();
    }
  }
  return candidate;
}

function parseConfigAssignments(content: string): Map<string, string> | null {
  const assignments = new Map<string, string>();
  for (const line of content.split(/\r?\n/).slice(1)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    const match = trimmedLine.match(CONFIG_ASSIGNMENT_PATTERN);
    if (!match || assignments.has(match[1])) return null;
    assignments.set(match[1], tomlValueWithoutInlineComment(match[2].trim()));
  }
  return assignments;
}

function hasCanonicalLegacyKeys(assignments: Map<string, string>): boolean {
  for (const key of LEGACY_REQUIRED_CONFIG_KEYS) {
    if (!assignments.has(key)) return false;
  }
  return [...assignments].every(([key]) =>
    LEGACY_REQUIRED_CONFIG_KEYS.has(key) || key === LEGACY_OPTIONAL_CONFIG_KEY
  );
}

function isCanonicalNonEmptyTomlString(candidate: string): boolean {
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === "string"
      && parsed.length > 0
      && JSON.stringify(parsed) === candidate;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function isCanonicalPositiveSafeInteger(candidate: string): boolean {
  return CANONICAL_INTEGER_PATTERN.test(candidate)
    && Number.isSafeInteger(Number(candidate));
}

function hasCanonicalDynamicValues(assignments: Map<string, string>): boolean {
  const stringsValid = LEGACY_DYNAMIC_STRING_KEYS.every((key) => {
    const candidate = assignments.get(key);
    return candidate === undefined
      ? key === LEGACY_OPTIONAL_CONFIG_KEY
      : isCanonicalNonEmptyTomlString(candidate);
  });
  if (!stringsValid) return false;
  const serverPort = assignments.get("server-port") || "";
  const databasePool = assignments.get("db-pool") || "";
  return isCanonicalPositiveSafeInteger(serverPort)
    && Number(serverPort) <= 65535
    && isCanonicalPositiveSafeInteger(databasePool);
}

function hasCanonicalStaticValues(
  assignments: Map<string, string>,
  projectRef: string,
): boolean {
  for (const [key, expected] of LEGACY_STATIC_CONFIG_VALUES) {
    if (assignments.get(key) !== expected) return false;
  }
  return assignments.get("db-channel") === JSON.stringify(`pgrst_${projectRef}`);
}

function isCanonicalLegacyConfig(content: string, projectRef: string): boolean {
  const [header] = content.split(/\r?\n/, 1);
  if (header !== `# PostgREST config for tenant: ${projectRef}`) return false;
  const assignments = parseConfigAssignments(content);
  return assignments !== null
    && hasCanonicalLegacyKeys(assignments)
    && hasCanonicalDynamicValues(assignments)
    && hasCanonicalStaticValues(assignments, projectRef);
}

function renderDbPoolMatch(content: string, match: RegExpExecArray, desiredPool: number): string | null {
  if (Number(match[2]) === desiredPool) return null;
  const start = match.index;
  const replacement = `${match[1]}${desiredPool}${match[3]}`;
  return `${content.slice(0, start)}${replacement}${content.slice(start + match[0].length)}`;
}

export function renderManagedPostgrestDbPool(
  content: string,
  desiredPool: number,
  projectRef: string,
): string | null {
  assertDesiredPool(desiredPool);
  const managed = content.startsWith(MANAGED_CONFIG_PREFIX);
  if (!managed && !isCanonicalLegacyConfig(content, projectRef)) return null;
  const matches = [...content.matchAll(DB_POOL_LINE_PATTERN)];
  if (matches.length !== 1) {
    if (!managed) return null;
    throw new Error("Managed PostgREST config must contain exactly one db-pool setting");
  }
  return renderDbPoolMatch(content, matches[0], desiredPool);
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
    request.projectRef,
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
