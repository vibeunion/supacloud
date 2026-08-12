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
  projectRef: string;
  desiredPool: number;
  projectStatus: string;
  desiredState: "running" | "stopped";
  operations: PostgrestPoolReconcileOperations;
}

export interface PostgrestPoolGeneration {
  content: string;
  pointerTarget: string;
  revision: string;
}

export interface PostgrestPoolReconcileOperations {
  readCurrentGeneration: () => Promise<PostgrestPoolGeneration>;
  candidateGeneration: (content: string) => PostgrestPoolGeneration;
  activateCandidate: (
    content: string,
    expectedPreviousPointerTarget: string,
  ) => Promise<PostgrestPoolGeneration>;
  currentPointerTarget: () => Promise<string | null>;
  validateGeneration: (generation: PostgrestPoolGeneration) => Promise<void>;
  restorePointer: (generation: PostgrestPoolGeneration) => Promise<void>;
  restartAndAttest: (expectedRevision: string) => Promise<void>;
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

function isEligible(request: PostgrestPoolReconcileRequest): boolean {
  return request.projectStatus === "active" && request.desiredState === "running";
}

function sameGeneration(
  left: PostgrestPoolGeneration,
  right: PostgrestPoolGeneration,
): boolean {
  return left.pointerTarget === right.pointerTarget && left.revision === right.revision;
}

async function rollBackPoolUpdate(
  request: PostgrestPoolReconcileRequest,
  original: PostgrestPoolGeneration,
  candidate: PostgrestPoolGeneration,
  updateError: unknown,
): Promise<PostgrestPoolReconcileResult> {
  await request.operations.validateGeneration(original);
  const currentPointerTarget = await request.operations.currentPointerTarget();
  if (currentPointerTarget !== original.pointerTarget
    && currentPointerTarget !== candidate.pointerTarget) {
    throw new Error("PostgREST generation changed concurrently during pool rollback");
  }
  if (currentPointerTarget !== original.pointerTarget) {
    await request.operations.restorePointer(original);
  }
  await request.operations.restartAndAttest(original.revision);
  return {
    state: "rolled_back",
    error: "POSTGREST_POOL_UPDATE_ROLLED_BACK",
    cause: updateError,
  };
}

export async function reconcileManagedPostgrestPool(
  request: PostgrestPoolReconcileRequest,
): Promise<PostgrestPoolReconcileResult> {
  if (!isEligible(request)) return { state: "skipped" };
  const original = await request.operations.readCurrentGeneration();
  const candidateContent = renderManagedPostgrestDbPool(
    original.content,
    request.desiredPool,
    request.projectRef,
  );
  if (candidateContent === null) return { state: "unchanged" };
  const candidate = request.operations.candidateGeneration(candidateContent);
  try {
    const activated = await request.operations.activateCandidate(
      candidateContent,
      original.pointerTarget,
    );
    if (!sameGeneration(activated, candidate)) {
      throw new Error("Activated PostgREST pool generation does not match its candidate");
    }
    await request.operations.restartAndAttest(candidate.revision);
    return { state: "updated" };
  } catch (updateError: unknown) {
    try {
      return await rollBackPoolUpdate(request, original, candidate, updateError);
    } catch (rollbackError: unknown) {
      throw new PostgrestPoolReconcileError(updateError, rollbackError);
    }
  }
}
