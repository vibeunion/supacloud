import { randomUUID } from "node:crypto";
import { access, realpath, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { config } from "../config";
import { getProjectDb, sql } from "../db";
import { createBackupWithEvidence, getPgBackRestStanza, listBackups } from "./backup.service";
import { logger } from "../utils/logger";

const SUPPORTED_POSTGRES_MAJORS = new Set([14, 15, 16, 17, 18]);
const EXECUTOR_TIMEOUT_MS = 6 * 60 * 60_000;
const LEASE_MS = 30_000;
const WORKER_INTERVAL_MS = 5_000;
const TRUSTED_EXECUTOR_DIRS = ["/opt/supacloud/scripts/lib/", "/usr/local/libexec/supacloud/"];

export function isTrustedExecutorMetadata(metadata: { isFile: boolean; uid?: number; mode?: number }): boolean {
  return metadata.isFile === true && metadata.uid === 0 && typeof metadata.mode === "number" && (metadata.mode & 0o022) === 0;
}

export function shouldRecoverPostgresUpgrade(status: PostgresUpgradeStatus): boolean {
  return status === "backup_running" || status === "validating" || status === "rollback_requested";
}

export function publicPostgresUpgradeStatus(row: Record<string, unknown>, ref: string) {
  const upgradeStatus = String(row.status);
  return {
    id: String(row.id),
    status: upgradeStatus,
    capability: true,
    available: true,
    scope: "cluster" as const,
    current_version: String(row.current_major),
    target_version: String(row.target_major),
    upgrade_status: upgradeStatus,
    requested_by_current_project: String(row.requested_project_ref) === ref,
  };
}

export function buildPostgresUpgradeScopeSnapshot(
  projects: Array<Record<string, unknown>>,
  capturedAt = new Date().toISOString(),
) {
  return {
    scope: "cluster" as const,
    project_count: projects.length,
    projects: projects.map((project) => ({
      ref: project.ref,
      status: project.status,
      database_name: project.db_name,
    })),
    captured_at: capturedAt,
  };
}

export function parsePostgresUpgradeScopeDatabases(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new PostgresMajorUpgradeError("PostgreSQL upgrade scope snapshot is missing", 503, "postgres_upgrade_scope_invalid");
  }
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.projects) || Number(record.project_count) !== record.projects.length) {
    throw new PostgresMajorUpgradeError("PostgreSQL upgrade scope snapshot is incomplete", 503, "postgres_upgrade_scope_invalid");
  }
  const seenRefs = new Set<string>();
  const seenDatabases = new Set<string>();
  return record.projects.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade scope contains an invalid project", 503, "postgres_upgrade_scope_invalid");
    }
    const project = entry as Record<string, unknown>;
    const ref = typeof project.ref === "string" ? project.ref : "";
    const databaseName = typeof project.database_name === "string" ? project.database_name : "";
    if (!ref || !databaseName || seenRefs.has(ref) || seenDatabases.has(databaseName)) {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade scope contains missing or duplicate databases", 503, "postgres_upgrade_scope_invalid");
    }
    seenRefs.add(ref);
    seenDatabases.add(databaseName);
    return { ref, databaseName };
  });
}

export function assertPostgresUpgradeScopeUnchanged(
  snapshot: unknown,
  currentProjects: Array<Record<string, unknown>>,
): void {
  const expected = parsePostgresUpgradeScopeDatabases(snapshot)
    .map((project) => `${project.ref}\0${project.databaseName}`)
    .sort();
  const current = currentProjects
    .map((project) => `${String(project.ref || "")}\0${String(project.db_name || "")}`)
    .sort();
  if (expected.length !== current.length || expected.some((entry, index) => entry !== current[index])) {
    throw new PostgresMajorUpgradeError(
      "The active project database scope changed after the upgrade backup",
      503,
      "postgres_upgrade_scope_changed",
    );
  }
}

export type PostgresUpgradeStatus =
  | "draft"
  | "preflight_running"
  | "preflight_failed"
  | "awaiting_approval"
  | "backup_running"
  | "upgrade_running"
  | "validating"
  | "succeeded"
  | "rollback_requested"
  | "rollback_running"
  | "rolled_back"
  | "failed"
  | "manual_recovery_required"
  | "cancelled";

export type PostgresUpgradeCheck = {
  id: string;
  status: "pass" | "warning" | "fail" | "unknown";
  message: string;
  details?: Record<string, unknown>;
};

export class PostgresMajorUpgradeError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "postgres_upgrade_error") {
    super(message);
    this.name = "PostgresMajorUpgradeError";
  }
}

export function normalizePostgresMajor(currentVersion: string | number, targetVersion: string | number) {
  const current = Number.parseInt(String(currentVersion), 10);
  const target = Number.parseInt(String(targetVersion), 10);
  if (!SUPPORTED_POSTGRES_MAJORS.has(current) || !SUPPORTED_POSTGRES_MAJORS.has(target)) {
    throw new PostgresMajorUpgradeError("PostgreSQL major version is not supported");
  }
  if (target <= current) throw new PostgresMajorUpgradeError("Target PostgreSQL major must be newer than the current major");
  return { current, target };
}

export function buildPostgresMajorUpgradePlan(input: {
  id: string;
  requestedProjectRef: string;
  currentMajor: number;
  targetMajor: number;
}) {
  return {
    id: input.id,
    scope: "cluster" as const,
    requested_project_ref: input.requestedProjectRef,
    affects_all_projects: true,
    current_major: input.currentMajor,
    target_major: input.targetMajor,
    strategy: "provider_executor_backup_restore",
    required_confirmation: `UPGRADE POSTGRES CLUSTER ${input.currentMajor} TO ${input.targetMajor}:${input.id}`,
    steps: [
      { id: "preflight", reversible: true },
      { id: "full_backup", reversible: true },
      { id: "upgrade", reversible: false },
      { id: "validate", reversible: false },
      { id: "cutover", reversible: false },
      { id: "rollback_window", reversible: true },
    ],
  };
}

export function summarizePostgresUpgradePreflight(checks: PostgresUpgradeCheck[]) {
  return {
    ready: checks.every((check) => check.status === "pass" || check.status === "warning"),
    blockers: checks.filter((check) => check.status === "fail" || check.status === "unknown").map((check) => check.id),
    warnings: checks.filter((check) => check.status === "warning").map((check) => check.id),
  };
}

const TRANSITIONS: Record<PostgresUpgradeStatus, ReadonlySet<PostgresUpgradeStatus>> = {
  draft: new Set(["preflight_running", "cancelled"]),
  preflight_running: new Set(["preflight_failed", "awaiting_approval", "cancelled"]),
  preflight_failed: new Set(["preflight_running", "cancelled"]),
  awaiting_approval: new Set(["backup_running", "preflight_running", "cancelled"]),
  backup_running: new Set(["upgrade_running", "failed", "cancelled"]),
  upgrade_running: new Set(["validating", "rollback_running", "manual_recovery_required"]),
  validating: new Set(["succeeded", "rollback_running", "manual_recovery_required"]),
  succeeded: new Set([]),
  rollback_running: new Set(["rolled_back", "manual_recovery_required"]),
  rolled_back: new Set([]),
  failed: new Set([]),
  manual_recovery_required: new Set(["rollback_requested"]),
  rollback_requested: new Set(["rollback_running", "manual_recovery_required"]),
  cancelled: new Set([]),
};

export function canTransitionPostgresUpgrade(from: PostgresUpgradeStatus, to: PostgresUpgradeStatus): boolean {
  return TRANSITIONS[from].has(to);
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = sql.unsafe(`
      CREATE TABLE IF NOT EXISTS postgres_major_upgrades (
        id uuid PRIMARY KEY,
        requested_project_ref text NOT NULL REFERENCES projects(ref) ON DELETE RESTRICT,
        scope text NOT NULL DEFAULT 'cluster' CHECK (scope = 'cluster'),
        current_major integer NOT NULL,
        target_major integer NOT NULL,
        status text NOT NULL,
        strategy text NOT NULL DEFAULT 'provider_executor_backup_restore',
        preflight jsonb NOT NULL DEFAULT '{}'::jsonb,
        backup_id text,
        backup_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        scope_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        executor_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        error_code text,
        error_message text,
        approved_at timestamptz,
        started_at timestamptz,
        completed_at timestamptz,
        lease_owner text,
        lease_token uuid,
        lease_expires_at timestamptz,
        heartbeat_at timestamptz,
        fencing_epoch bigint NOT NULL DEFAULT 0,
        rollback_requested_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS postgres_major_upgrades_one_active_idx
        ON postgres_major_upgrades(scope)
        WHERE status IN ('draft','preflight_running','awaiting_approval','backup_running','upgrade_running','validating','rollback_running');
      CREATE UNIQUE INDEX IF NOT EXISTS postgres_major_upgrades_cluster_fence_v2_idx
        ON postgres_major_upgrades(scope)
        WHERE status IN ('draft','preflight_running','awaiting_approval','backup_running','upgrade_running','validating','rollback_requested','rollback_running','manual_recovery_required');
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS backup_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS scope_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS executor_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS lease_owner text;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS lease_token uuid;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS fencing_epoch bigint NOT NULL DEFAULT 0;
      ALTER TABLE postgres_major_upgrades ADD COLUMN IF NOT EXISTS rollback_requested_at timestamptz;
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function currentMajorFromServerVersionNum(value: unknown): number {
  const versionNum = Number(value);
  if (!Number.isFinite(versionNum) || versionNum < 100_000) {
    throw new PostgresMajorUpgradeError("Unable to determine the current PostgreSQL major", 503, "postgres_version_unavailable");
  }
  return Math.floor(versionNum / 10_000);
}

async function resolveExecutorPath(): Promise<string> {
  const configured = (process.env.SUPACLOUD_POSTGRES_MAJOR_UPGRADE_EXECUTOR || "").trim();
  if (!configured.startsWith("/") || !/^\/[A-Za-z0-9_./-]+$/.test(configured) || configured.includes("..")) {
    throw new PostgresMajorUpgradeError(
      "SUPACLOUD_POSTGRES_MAJOR_UPGRADE_EXECUTOR must be an absolute allow-listed executable path",
      503,
      "postgres_upgrade_executor_unavailable",
    );
  }
  const resolved = await realpath(configured).catch(() => "");
  if (!resolved || !TRUSTED_EXECUTOR_DIRS.some((directory) => resolved.startsWith(directory))) {
    throw new PostgresMajorUpgradeError("PostgreSQL upgrade executor must resolve inside a trusted directory", 503, "postgres_upgrade_executor_untrusted");
  }
  const metadata = await stat(resolved).catch(() => null);
  if (!metadata || !isTrustedExecutorMetadata({ isFile: metadata.isFile(), uid: metadata.uid, mode: metadata.mode })) {
    throw new PostgresMajorUpgradeError("PostgreSQL upgrade executor must be a root-owned non-writable regular file", 503, "postgres_upgrade_executor_untrusted");
  }
  return resolved;
}

async function runExecutor(action: "preflight" | "execute" | "rollback", id: string, current: number, target: number, fencingToken?: string) {
  const executable = await resolveExecutorPath();
  await access(executable, constants.X_OK).catch(() => {
    throw new PostgresMajorUpgradeError("PostgreSQL upgrade executor is not executable", 503, "postgres_upgrade_executor_unavailable");
  });
  const child = Bun.spawn([
    executable,
    action,
    "--upgrade-id", id,
    "--current-major", String(current),
    "--target-major", String(target),
    ...(fencingToken ? ["--fencing-token", fencingToken] : []),
  ], {
    env: { ...process.env, SUPACLOUD_POSTGRES_UPGRADE_NONINTERACTIVE: "true" },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let forceKill: Timer | null = null;
  let timedOut = false;
  const killProcessGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  let timeout: Timer | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      forceKill = setTimeout(() => {
        killProcessGroup("SIGKILL");
        reject(new PostgresMajorUpgradeError(
          `PostgreSQL upgrade executor ${action} timed out`,
          503,
          `postgres_upgrade_${action}_timeout`,
        ));
      }, 5_000);
    }, EXECUTOR_TIMEOUT_MS);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      timeoutPromise,
    ]);
    if (timedOut) {
      throw new PostgresMajorUpgradeError(
        `PostgreSQL upgrade executor ${action} timed out`,
        503,
        `postgres_upgrade_${action}_timeout`,
      );
    }
    if (exitCode !== 0) {
      logger.error("[PostgresUpgrade] Executor failed", { action, exitCode });
      throw new PostgresMajorUpgradeError(
        `PostgreSQL upgrade executor ${action} failed: ${(stderr || stdout).trim().slice(0, 500) || `exit ${exitCode}`}`,
        503,
        `postgres_upgrade_${action}_failed`,
      );
    }
    return stdout.trim();
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  }
}

async function readUpgrade(id: string) {
  const [row] = await sql`SELECT * FROM postgres_major_upgrades WHERE id = ${id} LIMIT 1`;
  if (!row) throw new PostgresMajorUpgradeError("PostgreSQL upgrade was not found", 404, "postgres_upgrade_not_found");
  return row as Record<string, unknown>;
}

async function transition(
  id: string,
  next: PostgresUpgradeStatus,
  patch: Record<string, unknown> = {},
  expectedLeaseToken?: string,
) {
  const current = await readUpgrade(id);
  const previous = String(current.status) as PostgresUpgradeStatus;
  if (!canTransitionPostgresUpgrade(previous, next)) {
    throw new PostgresMajorUpgradeError(`Cannot transition PostgreSQL upgrade from ${previous} to ${next}`, 409, "postgres_upgrade_invalid_transition");
  }
  const [updated] = await sql`
    UPDATE postgres_major_upgrades
    SET status = ${next},
        preflight = COALESCE(${patch.preflight === undefined ? null : JSON.stringify(patch.preflight)}::jsonb, preflight),
        backup_id = COALESCE(${patch.backup_id ?? null}, backup_id),
        backup_evidence = COALESCE(${patch.backup_evidence === undefined ? null : JSON.stringify(patch.backup_evidence)}::jsonb, backup_evidence),
        scope_snapshot = COALESCE(${patch.scope_snapshot === undefined ? null : JSON.stringify(patch.scope_snapshot)}::jsonb, scope_snapshot),
        executor_evidence = COALESCE(${patch.executor_evidence === undefined ? null : JSON.stringify(patch.executor_evidence)}::jsonb, executor_evidence),
        error_code = ${patch.error_code ?? null},
        error_message = ${patch.error_message ?? null},
        lease_owner = CASE WHEN ${patch.clear_lease === true} THEN NULL ELSE lease_owner END,
        lease_token = CASE WHEN ${patch.clear_lease === true} THEN NULL ELSE lease_token END,
        lease_expires_at = CASE WHEN ${patch.clear_lease === true} THEN NULL ELSE lease_expires_at END,
        heartbeat_at = CASE WHEN ${patch.clear_lease === true} THEN heartbeat_at ELSE heartbeat_at END,
        rollback_requested_at = COALESCE(${patch.rollback_requested_at ?? null}::timestamptz, rollback_requested_at),
        approved_at = CASE WHEN ${next} = 'backup_running' THEN now() ELSE approved_at END,
        started_at = CASE WHEN ${next} = 'upgrade_running' THEN now() ELSE started_at END,
        completed_at = CASE WHEN ${next} IN ('succeeded','rolled_back','failed','manual_recovery_required','cancelled') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = ${id} AND status = ${previous}
      AND (${expectedLeaseToken ?? null}::uuid IS NULL OR lease_token = ${expectedLeaseToken ?? null}::uuid)
    RETURNING *
  `;
  if (!updated) throw new PostgresMajorUpgradeError("PostgreSQL upgrade changed concurrently", 409, "postgres_upgrade_conflict");
  return updated;
}

async function runPreflight(id: string, requestedRef: string, currentMajor: number, targetMajor: number) {
  await transition(id, "preflight_running");
  const checks: PostgresUpgradeCheck[] = [];
  const [projectCount] = await sql`SELECT count(*)::integer AS count FROM projects WHERE status <> 'deleted' AND deleted_at IS NULL`;
  checks.push({
    id: "scope",
    status: "warning",
    message: `This is a cluster-wide upgrade affecting ${Number(projectCount?.count || 0)} project(s)`,
    details: { requested_project_ref: requestedRef, project_count: Number(projectCount?.count || 0) },
  });

  try {
    const backups = await listBackups();
    const latestFull = backups.filter((backup) => backup.type === "full").sort((a, b) => b.timestamp.stop - a.timestamp.stop)[0];
    checks.push(latestFull
      ? { id: "backup", status: "pass", message: `Readable full backup ${latestFull.id} is available` }
      : { id: "backup", status: "fail", message: "No readable full backup is available" });
  } catch {
    checks.push({ id: "backup", status: "unknown", message: "pgBackRest backup inventory is unavailable" });
  }

  try {
    const [size] = await sql`
      SELECT COALESCE(sum(pg_database_size(datname)), 0)::bigint AS bytes
      FROM pg_database
      WHERE datallowconn = true AND datistemplate = false
    `;
    const fs = await statfs(config.pgDataDir);
    const availableBytes = Number(fs.bavail) * Number(fs.bsize);
    const databaseBytes = Number(size?.bytes || 0);
    const requiredBytes = Math.ceil(databaseBytes * 2.2);
    checks.push({
      id: "disk",
      status: availableBytes >= requiredBytes ? "pass" : "fail",
      message: availableBytes >= requiredBytes ? "Target volume has upgrade headroom" : "Target volume lacks 2.2x database-size free space",
      details: { available_bytes: availableBytes, required_bytes: requiredBytes },
    });
  } catch {
    checks.push({ id: "disk", status: "unknown", message: "Cannot inspect database size or target volume" });
  }

  const [prepared] = await sql`SELECT count(*)::integer AS count FROM pg_prepared_xacts`;
  checks.push(Number(prepared?.count || 0) === 0
    ? { id: "prepared_transactions", status: "pass", message: "No prepared transactions are pending" }
    : { id: "prepared_transactions", status: "fail", message: "Prepared transactions must be resolved before upgrade" });

  const [replacement] = await sql`SELECT count(*)::integer AS count FROM branch_replacement_journal`;
  checks.push(Number(replacement?.count || 0) === 0
    ? { id: "branch_replacement", status: "pass", message: "No database replacement recovery is active" }
    : { id: "branch_replacement", status: "fail", message: "A branch database replacement is active" });

  try {
    const output = await runExecutor("preflight", id, currentMajor, targetMajor, randomUUID());
    const evidence = parseExecutorEvidence(output);
    if (evidence.cluster_scope !== true || evidence.restore_verified !== true) {
      throw new PostgresMajorUpgradeError("Provider preflight must verify cluster scope and a restore drill", 503, "postgres_upgrade_preflight_evidence_missing");
    }
    checks.push({ id: "executor", status: "pass", message: "Provider upgrade executor passed its compatibility and restore-drill checks", details: evidence });
  } catch (error) {
    checks.push({ id: "executor", status: "fail", message: error instanceof Error ? error.message : "Provider executor is unavailable" });
  }

  const summary = summarizePostgresUpgradePreflight(checks);
  const preflight = { ...summary, checks, checked_at: new Date().toISOString() };
  await transition(id, summary.ready ? "awaiting_approval" : "preflight_failed", { preflight });
  return preflight;
}

function parseExecutorEvidence(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new PostgresMajorUpgradeError("Provider upgrade executor must return JSON evidence", 503, "postgres_upgrade_executor_evidence_invalid");
  }
}

const workerOwner = randomUUID();
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerInFlight = false;

async function claimNextWork() {
  const token = randomUUID();
  const [row] = await sql`
    WITH candidate AS (
      SELECT id
      FROM postgres_major_upgrades
      WHERE status IN ('backup_running','upgrade_running','validating','rollback_requested','rollback_running')
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE postgres_major_upgrades AS upgrade
    SET lease_owner = ${workerOwner},
        lease_token = ${token}::uuid,
        lease_expires_at = now() + (${LEASE_MS} * interval '1 millisecond'),
        heartbeat_at = now(),
        fencing_epoch = upgrade.fencing_epoch + 1,
        updated_at = now()
    WHERE upgrade.id = (SELECT id FROM candidate)
    RETURNING upgrade.*
  `;
  return row ? { row: row as Record<string, unknown>, token } : null;
}

async function heartbeat(id: string, token: string): Promise<boolean> {
  const [row] = await sql`
    UPDATE postgres_major_upgrades
    SET lease_expires_at = now() + (${LEASE_MS} * interval '1 millisecond'), heartbeat_at = now(), updated_at = now()
    WHERE id = ${id} AND lease_token = ${token}::uuid
    RETURNING id
  `;
  return Boolean(row);
}

async function validateUpgrade(target: number, scopeSnapshot: unknown) {
  const [version] = await sql`SHOW server_version_num`;
  const observed = currentMajorFromServerVersionNum(version?.server_version_num);
  if (observed !== target) {
    throw new PostgresMajorUpgradeError(`Post-upgrade validation observed PostgreSQL ${observed}, expected ${target}`, 503, "postgres_upgrade_validation_failed");
  }
  const scopedDatabases = parsePostgresUpgradeScopeDatabases(scopeSnapshot);
  const currentProjects = await sql`
    SELECT ref, db_name FROM projects
    WHERE status <> 'deleted' AND deleted_at IS NULL
    ORDER BY ref
  `;
  assertPostgresUpgradeScopeUnchanged(scopeSnapshot, currentProjects as Array<Record<string, unknown>>);
  const databaseEvidence = [];
  for (const scoped of scopedDatabases) {
    const [metadata] = await sql`
      SELECT ref, db_name FROM projects
      WHERE ref = ${scoped.ref} AND status <> 'deleted' AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!metadata || String(metadata.db_name) !== scoped.databaseName) {
      throw new PostgresMajorUpgradeError(
        `Project ${scoped.ref} no longer matches the backed-up cluster scope`,
        503,
        "postgres_upgrade_scope_changed",
      );
    }
    const projectDb = getProjectDb(scoped.databaseName);
    const [databaseVersion] = await projectDb`SHOW server_version_num`;
    const [probe] = await projectDb`SELECT current_database() AS database_name`;
    const projectObserved = currentMajorFromServerVersionNum(databaseVersion?.server_version_num);
    if (projectObserved !== target || String(probe?.database_name) !== scoped.databaseName) {
      throw new PostgresMajorUpgradeError(
        `Project ${scoped.ref} database validation failed after cutover`,
        503,
        "postgres_upgrade_project_validation_failed",
      );
    }
    databaseEvidence.push({
      ref: scoped.ref,
      database_name: scoped.databaseName,
      observed_major: projectObserved,
      reachable: true,
    });
  }
  return {
    observed_major: observed,
    project_count: databaseEvidence.length,
    databases: databaseEvidence,
    validated_at: new Date().toISOString(),
  };
}

async function executeRollback(
  id: string,
  current: number,
  target: number,
  token: string,
  originalErrorCode: string,
  originalErrorMessage: string,
): Promise<void> {
  try {
    const rollbackOutput = await runExecutor("rollback", id, current, target, token);
    const rollbackEvidence = parseExecutorEvidence(rollbackOutput);
    if (rollbackEvidence.rollback_verified !== true || rollbackEvidence.fencing_token !== token) {
      throw new PostgresMajorUpgradeError(
        "Provider rollback evidence is incomplete",
        503,
        "postgres_upgrade_rollback_evidence_missing",
      );
    }
    await transition(id, "rolled_back", {
      executor_evidence: rollbackEvidence,
      error_code: originalErrorCode,
      error_message: originalErrorMessage,
      clear_lease: true,
    }, token);
  } catch (rollbackError) {
    await transition(id, "manual_recovery_required", {
      error_code: "postgres_upgrade_rollback_failed",
      error_message: `${originalErrorMessage}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      clear_lease: true,
    }, token).catch(() => undefined);
  }
}

async function processClaimedWork(row: Record<string, unknown>, token: string): Promise<void> {
  const id = String(row.id);
  const current = Number(row.current_major);
  const target = Number(row.target_major);
  const status = String(row.status) as PostgresUpgradeStatus;
  if (status === "upgrade_running") {
    await transition(id, "manual_recovery_required", {
      error_code: "postgres_upgrade_executor_state_unknown",
      error_message: "The Management API restarted while the provider executor was running; automatic re-execution is forbidden",
      clear_lease: true,
    }, token).catch(() => undefined);
    return;
  }
  if (status === "rollback_requested") {
    await transition(id, "rollback_running", {}, token);
    await executeRollback(
      id,
      current,
      target,
      token,
      String(row.error_code || "postgres_upgrade_manual_rollback"),
      String(row.error_message || "Manual rollback requested"),
    );
    return;
  }
  if (status === "rollback_running") {
    await transition(id, "manual_recovery_required", {
      error_code: "postgres_upgrade_rollback_state_unknown",
      error_message: "The Management API restarted while rollback was running; manual provider reconciliation is required",
      clear_lease: true,
    }, token).catch(() => undefined);
    return;
  }
  if (status === "validating") {
    try {
      const validation = await validateUpgrade(target, row.scope_snapshot);
      const existingEvidence = row.executor_evidence && typeof row.executor_evidence === "object"
        ? row.executor_evidence as Record<string, unknown>
        : {};
      await transition(id, "succeeded", { executor_evidence: { ...existingEvidence, validation }, clear_lease: true }, token);
    } catch (error) {
      await transition(id, "manual_recovery_required", {
        error_code: "postgres_upgrade_validation_failed",
        error_message: error instanceof Error ? error.message : String(error),
        clear_lease: true,
      }, token).catch(() => undefined);
    }
    return;
  }

  let executionStarted = false;
  try {
    if (status === "backup_running") {
      const backupResult = await createBackupWithEvidence("full");
      const projects = await sql`
        SELECT ref, status, db_name FROM projects WHERE status <> 'deleted' AND deleted_at IS NULL ORDER BY ref
      `;
      const scopeSnapshot = buildPostgresUpgradeScopeSnapshot(projects as Array<Record<string, unknown>>);
      await transition(id, "upgrade_running", {
        backup_id: backupResult.backup.id,
        backup_evidence: {
          id: backupResult.backup.id,
          type: backupResult.backup.type,
          timestamp: backupResult.backup.timestamp,
          size: backupResult.backup.size,
          stanza: getPgBackRestStanza(),
          completed_at: new Date().toISOString(),
        },
        scope_snapshot: scopeSnapshot,
      }, token);
      executionStarted = true;
    }
    const executorOutput = await runExecutor("execute", id, current, target, token);
    const executorEvidence = parseExecutorEvidence(executorOutput);
    if (executorEvidence.cluster_scope !== true || executorEvidence.cutover_verified !== true || executorEvidence.fencing_token !== token) {
      throw new PostgresMajorUpgradeError("Provider executor must return cluster cutover evidence", 503, "postgres_upgrade_executor_evidence_missing");
    }
    await transition(id, "validating", { executor_evidence: executorEvidence }, token);
    const latest = await readUpgrade(id);
    const validation = await validateUpgrade(target, latest.scope_snapshot);
    await transition(id, "succeeded", { executor_evidence: { ...executorEvidence, validation }, clear_lease: true }, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof PostgresMajorUpgradeError ? error.code : "postgres_upgrade_failed";
    if (!executionStarted) {
      await transition(id, "failed", { error_code: code, error_message: message, clear_lease: true }, token).catch(() => undefined);
      return;
    }
    await transition(id, "manual_recovery_required", {
      error_code: code,
      error_message: `${message}; automatic rollback is blocked until post-cutover writes and tenant validation are reconciled`,
      clear_lease: true,
    }, token).catch(() => undefined);
  }
}

async function workerTick(): Promise<void> {
  if (workerInFlight) return;
  workerInFlight = true;
  try {
    await ensureSchema();
    const claimed = await claimNextWork();
    if (claimed) {
      const heartbeatTimer = setInterval(() => {
        void heartbeat(String(claimed.row.id), claimed.token).then((owned) => {
          if (!owned) logger.error("[PostgresUpgrade] Worker lost its fencing lease", { id: claimed.row.id });
        });
      }, Math.floor(LEASE_MS / 3));
      try {
        await processClaimedWork(claimed.row, claimed.token);
      } finally {
        clearInterval(heartbeatTimer);
      }
    }
  } catch (error) {
    logger.error("[PostgresUpgrade] Durable worker tick failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    workerInFlight = false;
  }
}

function startWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => void workerTick(), WORKER_INTERVAL_MS);
  void workerTick();
}

function stopWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export const postgresMajorUpgradeService = {
  startWorker,
  stopWorker,
  async request(ref: string, targetVersion: string | number) {
    await ensureSchema();
    const [version] = await sql`SHOW server_version_num`;
    const { current, target } = normalizePostgresMajor(currentMajorFromServerVersionNum(version?.server_version_num), targetVersion);
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO postgres_major_upgrades (id, requested_project_ref, current_major, target_major, status)
        VALUES (${id}, ${ref}, ${current}, ${target}, 'draft')
      `;
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "23505") {
        throw new PostgresMajorUpgradeError("Another cluster PostgreSQL upgrade is active", 409, "postgres_upgrade_active");
      }
      throw error;
    }
    const preflight = await runPreflight(id, ref, current, target);
    return { ...(await readUpgrade(id)), plan: buildPostgresMajorUpgradePlan({ id, requestedProjectRef: ref, currentMajor: current, targetMajor: target }), preflight };
  },

  async get(ref: string) {
    await ensureSchema();
    const [row] = await sql`
      SELECT * FROM postgres_major_upgrades
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!row) {
      const [version] = await sql`SHOW server_version_num`;
      return {
        status: "available",
        capability: true,
        available: true,
        scope: "cluster",
        current_version: String(currentMajorFromServerVersionNum(version?.server_version_num)),
        target_version: null,
        upgrade_status: "not_started",
      };
    }
    return publicPostgresUpgradeStatus(row as Record<string, unknown>, ref);
  },

  async approve(id: string, confirmation: string, requestedRef?: string) {
    await ensureSchema();
    const row = await readUpgrade(id);
    if (requestedRef && String(row.requested_project_ref) !== requestedRef) {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade does not belong to this project route", 404, "postgres_upgrade_not_found");
    }
    if (String(row.status) !== "awaiting_approval") {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade is not awaiting approval", 409, "postgres_upgrade_not_approvable");
    }
    const plan = buildPostgresMajorUpgradePlan({
      id,
      requestedProjectRef: String(row.requested_project_ref),
      currentMajor: Number(row.current_major),
      targetMajor: Number(row.target_major),
    });
    if (confirmation !== plan.required_confirmation) {
      throw new PostgresMajorUpgradeError("Exact cluster upgrade confirmation is required", 400, "postgres_upgrade_confirmation_required");
    }
    return transition(id, "backup_running");
  },

  async rollback(id: string, confirmation: string, requestedRef?: string) {
    await ensureSchema();
    const row = await readUpgrade(id);
    if (requestedRef && String(row.requested_project_ref) !== requestedRef) {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade does not belong to this project route", 404, "postgres_upgrade_not_found");
    }
    const expected = `ROLLBACK POSTGRES CLUSTER:${id}`;
    if (confirmation !== expected) {
      throw new PostgresMajorUpgradeError("Exact cluster rollback confirmation is required", 400, "postgres_upgrade_confirmation_required");
    }
    const current = String(row.status) as PostgresUpgradeStatus;
    if (!["manual_recovery_required"].includes(current)) {
      throw new PostgresMajorUpgradeError("PostgreSQL upgrade is not rollbackable in its current state", 409, "postgres_upgrade_not_rollbackable");
    }
    return transition(id, "rollback_requested", {
      rollback_requested_at: new Date().toISOString(),
      error_code: row.error_code ? String(row.error_code) : undefined,
      error_message: row.error_message ? String(row.error_message) : undefined,
    });
  },
};
