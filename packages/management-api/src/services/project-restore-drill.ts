import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { decryptSecretWithKey, isEncryptedSecret } from "../utils/secret-crypto-core";
import { stableStringify } from "../utils/stable-json";
import {
  COMPONENTS, DRILL_ID_PATTERN, DRILL_RECEIPT_SCHEMA, canonicalTime, parseRestoreSnapshot,
  sha256, signDrillDocument, verifyDrillDocument, type RestoreFile, type RestoreSnapshot,
} from "./restore-drill-contract";

const BACKUP = "/backup";
const DRILLS = "/drill";
const BOOTSTRAP_ROLE = "supacloud_drill_bootstrap";
const PG_PORT = "55432";
const EDGE_PORT = 19005;
type DrillPhase = "inventory" | "database" | "components" | "verification" | "complete";
export interface DrillReceipt {
  schema: typeof DRILL_RECEIPT_SCHEMA; drill_id: string; project_ref: string; snapshot_id: string;
  snapshot_sha256: string; backup_method: string; target: string; status: "running" | "succeeded" | "failed";
  phase: DrillPhase; started_at: string; completed_at: string | null;
  rpo_ms: number | null; rto_ms: number | null; failure_code: string | null;
  max_rpo_ms: number; max_rto_ms: number;
  recovered_through: string | null;
  checks: Array<{ category: string; name: string; evidence_sha256: string }>;
  signature: string;
}

function requiredKey(name: string): string {
  const key = process.env[name] ?? "";
  if (key.length < 32) throw new Error(`${name} is required`);
  return key;
}

export async function assertDrillIsolation(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    throw new Error("Restore drills require a non-root Linux container");
  }
  await lstat("/.dockerenv");
  if (Object.values(networkInterfaces()).flat().some((entry) => entry && !entry.internal)) {
    throw new Error("Restore drill networking must be disabled");
  }
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  if (!mounts.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === BACKUP && fields[5]?.split(",").includes("ro");
  })) throw new Error("Backup must be a read-only mount");
  for (const root of [BACKUP, DRILLS]) {
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("Drill roots must be canonical directories");
  }
  const target = await lstat(DRILLS);
  if (target.uid !== process.getuid?.() || (target.mode & 0o077) !== 0) throw new Error("Drill root must be private and owned by the runner");
}

async function syncFile(path: string, value: string, mode = 0o600): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}

async function writeReceipt(directory: string, receipt: DrillReceipt, key: string): Promise<void> {
  receipt.signature = signDrillDocument(receipt as unknown as Record<string, unknown>, key);
  const pending = join(directory, `.receipt-${randomUUID()}.tmp`);
  await syncFile(pending, JSON.stringify(receipt) + "\n");
  await rename(pending, join(directory, "receipt.json"));
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

async function inventoryPaths(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventoryPaths(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Snapshot contains a symlink or non-regular entry");
  }
  return files.sort();
}

async function verifyFile(root: string, entry: RestoreFile): Promise<void> {
  const file = await open(join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== entry.bytes) throw new Error("Snapshot file identity mismatch");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (let offset = 0; offset < before.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Snapshot file was truncated");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (hash.digest("hex") !== entry.sha256 || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Snapshot file digest mismatch");
    }
  } finally { await file.close(); }
}

export async function verifyRestoreInventory(root: string, snapshot: RestoreSnapshot): Promise<void> {
  const actual: string[] = [];
  for (const component of COMPONENTS) {
    const metadata = await lstat(join(root, component));
    if (!metadata.isDirectory()) throw new Error("Snapshot component must be a directory");
    actual.push(...(await inventoryPaths(join(root, component))).map((path) => `${component}/${path}`));
  }
  if (stableStringify(actual.sort()) !== stableStringify(snapshot.files.map((entry) => entry.path).sort())) {
    throw new Error("Snapshot inventory is incomplete");
  }
  for (const entry of snapshot.files) await verifyFile(root, entry);
}

function baseEnvironment() {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/drill", LANG: "C.UTF-8" };
}

async function run(cmd: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<string> {
  const child = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  let output = "";
  const decoder = new TextDecoder();
  try {
    const reader = child.stdout.getReader();
    try {
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 4 * 1024 * 1024) { child.kill("SIGKILL"); throw new Error("Drill command output limit exceeded"); }
        output += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    if (await child.exited !== 0) throw new Error("Drill command failed");
    return output.trim();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function databaseEnvironment(snapshot: RestoreSnapshot, directory: string, bootstrap = false) {
  return {
    ...baseEnvironment(), PGHOST: join(directory, "socket"), PGPORT: PG_PORT,
    PGUSER: bootstrap ? BOOTSTRAP_ROLE : snapshot.database.admin_role,
    ...(snapshot.database.repo_cipher_type === "aes-256-cbc"
      ? { PGBACKREST_REPO1_CIPHER_PASS: requiredKey("SUPACLOUD_PGBACKREST_REPO_KEY") } : {}),
  };
}

export function postgresRecoveryTimestamp(value: string): string {
  canonicalTime(value);
  return value.replace("T", " ").replace("Z", "+00");
}

export function pgbackrestArgs(snapshot: RestoreSnapshot, directory: string): string[] {
  return [
    "pgbackrest", "--config=/dev/null", `--stanza=${snapshot.database.stanza}`,
    "--repo1-type=posix", `--repo1-path=${directory}/input/database/repo`,
    `--repo1-cipher-type=${snapshot.database.repo_cipher_type ?? "none"}`,
    `--pg1-path=${directory}/pgdata`, `--lock-path=${directory}/lock`, `--log-path=${directory}/log`,
  ];
}

async function restoreDatabase(snapshot: RestoreSnapshot, directory: string): Promise<void> {
  const environment = databaseEnvironment(snapshot, directory, snapshot.database.kind === "logical-full");
  const version = await run(["postgres", "--version"], environment);
  if (!new RegExp(`\\b${snapshot.database.major}\\.\\d+`).test(version)) throw new Error("PostgreSQL major version mismatch");
  await mkdir(join(directory, "socket"), { mode: 0o700 });
  if (snapshot.database.kind === "pgbackrest") {
    await mkdir(join(directory, "lock"), { mode: 0o700 });
    await mkdir(join(directory, "log"), { mode: 0o700 });
    await run([
      ...pgbackrestArgs(snapshot, directory), `--set=${snapshot.database.backup_set}`, "--type=time",
      `--target=${postgresRecoveryTimestamp(snapshot.database.recovery_target!)}`, "--target-action=promote", "--archive-mode=off",
      `--tablespace-map-all=${directory}/tablespaces`, "restore",
    ], environment, snapshot.max_rto_ms);
  } else {
    await run(["initdb", "-D", join(directory, "pgdata"), "-U", BOOTSTRAP_ROLE, "--auth=trust", "--no-locale", "--encoding=UTF8"], environment);
  }
  // 不加载生产配置；只保留显式恢复目标及只读归档读取命令。
  const autoPath = join(directory, "pgdata", "postgresql.auto.conf");
  const auto = await open(autoPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const recovery = snapshot.database.kind === "pgbackrest" ? [
      `restore_command = '${[...pgbackrestArgs(snapshot, directory), "archive-get", "%f", '"%p"'].join(" ")}'`,
      `recovery_target_time = '${postgresRecoveryTimestamp(snapshot.database.recovery_target!)}'`,
      "recovery_target_action = 'promote'",
    ].join("\n") : "";
    await auto.writeFile(recovery + "\n"); await auto.sync();
  } finally { await auto.close(); }
  await syncFile(join(directory, "postgresql.conf"), [
    "listen_addresses = '127.0.0.1'", `port = ${PG_PORT}`,
    `unix_socket_directories = '${directory}/socket'`,
    `hba_file = '${directory}/pg_hba.conf'`, "ssl = off", "archive_mode = off",
    "shared_preload_libraries = ''", "session_preload_libraries = ''", "local_preload_libraries = ''",
  ].join("\n") + "\n");
  await syncFile(join(directory, "pg_hba.conf"), "local all all trust\nhost all all 127.0.0.1/32 trust\n");
  await run([
    "pg_ctl", "-D", join(directory, "pgdata"), "-l", join(directory, "postgres.log"), "-w", "-t", "120",
    "-o", `-c config_file=${directory}/postgresql.conf`, "start",
  ], environment);
  if (snapshot.database.kind === "logical-full") {
    await run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-f", join(directory, "input/database/globals.sql")], environment);
    await run(["createdb", "-O", snapshot.database.admin_role, snapshot.database.name], environment);
    await run(["pg_restore", "--exit-on-error", "--single-transaction", "-d", snapshot.database.name, join(directory, "input/database/database.dump")], environment, snapshot.max_rto_ms);
  }
}

async function sqlRows(snapshot: RestoreSnapshot, directory: string, query: string, role: string, claims?: Record<string, unknown>): Promise<unknown[]> {
  const claimsClause = claims === undefined ? "" : `SET LOCAL request.jwt.claims = '${JSON.stringify(claims).replaceAll("'", "''")}';`;
  const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout = '30s'; SET LOCAL ROLE "${role}"; ${claimsClause} SELECT COALESCE(json_agg(row_to_json(check_row)), '[]'::json) FROM (${query}) check_row; ROLLBACK;`;
  const output = await run(["psql", "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-d", snapshot.database.name, "-c", sql], databaseEnvironment(snapshot, directory), 35_000);
  const rows = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("Invalid SQL fixture result");
  return rows;
}

async function restoredRuntimeEnv(snapshot: RestoreSnapshot, directory: string, encryptionKey: string) {
  const encrypted = await readFile(join(directory, "input/secrets/runtime-env.enc"), "utf8");
  if (!isEncryptedSecret(encrypted)) throw new Error("Runtime environment must be encrypted");
  const restored = JSON.parse(decryptSecretWithKey(encrypted, encryptionKey));
  if (restored.snapshot_id !== snapshot.snapshot_id || restored.project_ref !== snapshot.project_ref
    || !restored.values || typeof restored.values !== "object" || Array.isArray(restored.values)
    || Object.keys(restored.values).length > 512 || Object.values(restored.values).some((value) => typeof value !== "string")) {
    throw new Error("Restored runtime environment identity mismatch");
  }
  const env: Record<string, string> = { ...restored.values };
  const databaseUrl = `postgresql://${snapshot.database.admin_role}@127.0.0.1:${PG_PORT}/${snapshot.database.name}`;
  for (const key of ["DATABASE_URL", "SUPABASE_DB_URL", "POSTGRES_URL", ...snapshot.database_env_keys]) env[key] = databaseUrl;
  Object.assign(env, {
    PGHOST: "127.0.0.1", PGPORT: PG_PORT, PGUSER: snapshot.database.admin_role, PGDATABASE: snapshot.database.name,
    SUPACLOUD_PROJECT_REF: snapshot.project_ref, X_PROJECT_REF: snapshot.project_ref,
    SUPACLOUD_DRILL_OBJECTS_DIR: join(directory, "objects"),
  });
  return env;
}

async function restoreComponents(snapshot: RestoreSnapshot, directory: string) {
  for (const entry of snapshot.files) {
    if (!entry.path.startsWith("runtime/") && !entry.path.startsWith("objects/")) continue;
    const target = entry.path.startsWith("runtime/")
      ? join(directory, "functions", snapshot.project_ref, entry.path.slice("runtime/".length))
      : join(directory, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(directory, "input", entry.path), target, constants.COPYFILE_EXCL);
    await verifyFile(dirname(target), { ...entry, path: target.split("/").at(-1)! });
  }
}

async function stopChild(child: Bun.Subprocess<"ignore", "ignore", "ignore">) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { await child.exited; } finally { clearTimeout(timer); }
}

async function verifyFunctions(snapshot: RestoreSnapshot, directory: string, env: Record<string, string>, receipt: DrillReceipt) {
  const token = randomUUID();
  const management = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`
        || new URL(request.url).pathname !== `/v1/projects/${snapshot.project_ref}/internal/runtime-env`) {
        return new Response(null, { status: 403 });
      }
      return Response.json(env, { headers: { "x-supacloud-runtime-env-revision": `hmac-sha256:${receipt.snapshot_sha256}` } });
    },
  });
  const edge = Bun.spawn([process.execPath, "--no-env-file", "/app/packages/edge-runtime/server.ts"], {
    env: {
      ...baseEnvironment(), EDGE_RUNTIME_HOST: "127.0.0.1", EDGE_RUNTIME_PORT: String(EDGE_PORT),
      EDGE_RUNTIME_MASTER_KEY: token, MASTER_TOKEN: token, MANAGEMENT_API_URL: `http://127.0.0.1:${management.port}`,
      EDGE_FUNCTIONS_DIR: join(directory, "functions"), EDGE_FUNCTIONS_BASE_DIR: join(directory, "functions"),
      TENANTS_DIR: join(directory, "tenants"), WORKER_POOL_SIZE: "1", BACKGROUND_WORKER_POOL_SIZE: "1",
    }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (edge.exitCode !== null) throw new Error("Restored runtime exited");
      try { if ((await fetch(`http://127.0.0.1:${EDGE_PORT}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      if (Date.now() >= deadline) throw new Error("Restored runtime did not become ready");
      await Bun.sleep(25);
    }
    for (const check of snapshot.http_checks) {
      const headers: Record<string, string> = { "x-project-ref": snapshot.project_ref };
      if (check.auth === "service_role") {
        if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Restored runtime credential is missing");
        headers.apikey = env.SUPABASE_SERVICE_ROLE_KEY;
      }
      const response = await fetch(`http://127.0.0.1:${EDGE_PORT}/functions/v1/${check.slug}${check.path}`, {
        headers, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      const bodyHash = sha256(new Uint8Array(await response.arrayBuffer()));
      if (response.status !== check.status || bodyHash !== check.sha256) throw new Error("Restored function canary mismatch");
      receipt.checks.push({ category: check.auth === "anonymous" ? "authorization" : "functions", name: check.slug, evidence_sha256: bodyHash });
    }
  } finally {
    await stopChild(edge);
    management.stop(true);
  }
}

export async function runProjectRestoreDrill(drillId: string, confirmation: string): Promise<DrillReceipt> {
  if (!DRILL_ID_PATTERN.test(drillId)) throw new Error("Invalid drill ID");
  await assertDrillIsolation();
  const signingKey = requiredKey("SUPACLOUD_SNAPSHOT_SIGNING_KEY");
  const encryptionKey = requiredKey("SUPACLOUD_RESTORE_ENCRYPTION_KEY");
  const receiptKey = requiredKey("SUPACLOUD_DRILL_RECEIPT_KEY");
  if (new Set([signingKey, encryptionKey, receiptKey]).size !== 3) throw new Error("Snapshot, encryption and receipt keys must be independent");
  const raw = await readFile(join(BACKUP, "manifest.json"), "utf8");
  const snapshot = parseRestoreSnapshot(raw, signingKey);
  if (confirmation !== `RESTORE_DRILL:${snapshot.project_ref}:${snapshot.snapshot_id}:${drillId}`) throw new Error("Exact restore-drill confirmation is required");
  const directory = join(DRILLS, drillId);
  await mkdir(directory, { mode: 0o700 });
  const started = performance.now();
  const receipt: DrillReceipt = {
    schema: DRILL_RECEIPT_SCHEMA, drill_id: drillId, project_ref: snapshot.project_ref,
    snapshot_id: snapshot.snapshot_id, snapshot_sha256: sha256(raw), backup_method: snapshot.database.kind,
    target: directory, status: "running", phase: "inventory", started_at: new Date().toISOString(), completed_at: null,
    rpo_ms: null, rto_ms: null, recovered_through: null, failure_code: null, checks: [], signature: "",
    max_rpo_ms: snapshot.max_rpo_ms, max_rto_ms: snapshot.max_rto_ms,
  };
  await writeReceipt(directory, receipt, receiptKey);
  try {
    await verifyRestoreInventory(BACKUP, snapshot);
    // 将已签名内容复制到私有目标再复验，后续命令不再读取可能被宿主机改动的源挂载。
    for (const entry of snapshot.files) {
      const target = join(directory, "input", entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(BACKUP, entry.path), target, constants.COPYFILE_EXCL);
      await verifyFile(join(directory, "input"), entry);
    }
    const env = await restoredRuntimeEnv(snapshot, directory, encryptionKey);
    receipt.checks.push({ category: "inventory", name: "complete-snapshot", evidence_sha256: sha256(stableStringify(snapshot.files)) });
    receipt.phase = "database"; await writeReceipt(directory, receipt, receiptKey);
    await restoreDatabase(snapshot, directory);
    const recoveryDeadline = Date.now() + Math.min(60_000, snapshot.max_rto_ms);
    while (true) {
      const rows = await sqlRows(snapshot, directory, "SELECT pg_is_in_recovery() AS recovering", snapshot.database.admin_role);
      if (stableStringify(rows) === stableStringify([{ recovering: false }])) break;
      if (Date.now() >= recoveryDeadline) throw new Error("PITR target has not been reached and promoted");
      await Bun.sleep(100);
    }
    receipt.phase = "components"; await writeReceipt(directory, receipt, receiptKey);
    await restoreComponents(snapshot, directory);
    receipt.phase = "verification"; await writeReceipt(directory, receipt, receiptKey);
    for (const check of snapshot.sql_checks) {
      if (check.category === "permissions") {
        const roles = await sqlRows(snapshot, directory,
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${check.role}'`, snapshot.database.admin_role);
        if (stableStringify(roles) !== stableStringify([{ rolsuper: false, rolbypassrls: false }])) {
          throw new Error("Permission checks cannot use a privileged database role");
        }
      }
      const rows = await sqlRows(snapshot, directory, check.query, check.role, check.claims);
      if (stableStringify(rows) !== stableStringify(check.expected)) throw new Error("Restored SQL fixture mismatch");
      receipt.checks.push({ category: check.category, name: check.name, evidence_sha256: sha256(stableStringify(rows)) });
    }
    const rows = await sqlRows(snapshot, directory, snapshot.marker_query, snapshot.database.admin_role);
    const marker = rows[0] as { snapshot_id?: string; recovered_through?: string } | undefined;
    if (rows.length !== 1 || marker?.snapshot_id !== snapshot.snapshot_id) throw new Error("Restored snapshot marker mismatch");
    const recovered = canonicalTime(marker.recovered_through);
    receipt.recovered_through = marker.recovered_through!;
    receipt.checks.push({ category: "recovery_point", name: "database-marker", evidence_sha256: sha256(stableStringify(rows)) });
    const incident = canonicalTime(snapshot.incident_at);
    if (recovered > incident || (snapshot.database.kind === "pgbackrest" && recovered > canonicalTime(snapshot.database.recovery_target))) {
      throw new Error("Invalid recovered database point");
    }
    await verifyFunctions(snapshot, directory, env, receipt);
    receipt.rpo_ms = incident - Math.min(recovered, ...Object.values(snapshot.recovery_points).map(canonicalTime));
    receipt.rto_ms = Math.round(performance.now() - started);
    if (receipt.rpo_ms > snapshot.max_rpo_ms || receipt.rto_ms > snapshot.max_rto_ms) throw new Error("Restore budget exceeded");
    receipt.status = "succeeded"; receipt.phase = "complete";
  } catch {
    receipt.status = "failed"; receipt.failure_code = `RESTORE_${receipt.phase.toUpperCase()}_FAILED`;
    receipt.rto_ms = Math.round(performance.now() - started);
  } finally {
    await run(["pg_ctl", "-D", join(directory, "pgdata"), "-m", "immediate", "-w", "stop"], databaseEnvironment(snapshot, directory), 10_000).catch(() => {});
    receipt.completed_at = new Date().toISOString();
    await writeReceipt(directory, receipt, receiptKey);
  }
  return receipt;
}

export async function readProjectRestoreDrill(drillId: string) {
  if (!DRILL_ID_PATTERN.test(drillId)) throw new Error("Invalid drill ID");
  const receipt = JSON.parse(await readFile(join(DRILLS, drillId, "receipt.json"), "utf8")) as DrillReceipt;
  verifyDrillDocument(receipt as unknown as Record<string, unknown>, requiredKey("SUPACLOUD_DRILL_RECEIPT_KEY"));
  if (receipt.schema !== DRILL_RECEIPT_SCHEMA || receipt.drill_id !== drillId || receipt.target !== join(DRILLS, drillId)) {
    throw new Error("Receipt target identity mismatch");
  }
  return { receipt, effective_status: receipt.status === "running" ? "outcome_unknown" : receipt.status };
}
