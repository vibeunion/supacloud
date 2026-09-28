import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, chmod, copyFile, stat, statfs } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { sha256 } from "../../src/services/restore-drill-contract";

export const RECOVERY_SOURCE_REF = "ugckmpkijwfbibxtaemr";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIB = 1024 * 1024;
const stages = ["original", "upgraded", "rollback"] as const;
type JsonRow = Record<string, unknown>;
interface BusinessRecord {
  stage: typeof stages[number]; reviewId: string; artifactId: string; runId: string; operation: string;
  durableResult: { reviewId: string; artifactId: string; version: number; sha256: string; bytes: number };
}
interface TableBackup {
  table: string; columns: string[]; rows: string; count: number; sha256: string;
}
interface ObjectBackup {
  artifactId: string; bucketId: string; objectPath: string; file: string; sha256: string; bytes: number;
}
const identifier = (name: string) => {
  assert.match(name, /^[a-z_][a-z0-9_]*$/);
  return `"${name}"`;
};
const relation = (name: string) => name.split(".").map(identifier).join(".");
const literalIds = (values: string[]) => {
  assert.ok(values.length > 0);
  for (const value of values) assert.match(value, UUID);
  return values.map(value => `'${value}'`).join(",");
};

export function businessRecoveryRecords(document: unknown): BusinessRecord[] {
  assert.ok(document && typeof document === "object");
  const doc = document as { status?: unknown; evidence?: Record<string, any> };
  assert.equal(doc.status, "PASS");
  assert.equal(doc.evidence?.rollbackPreservedData, true);
  const result = stages.map(stage => {
    const entry = doc.evidence?.[stage];
    assert.equal(entry?.readiness?.project_ref, RECOVERY_SOURCE_REF);
    assert.equal(entry?.readiness?.ready, true);
    const receipt = entry?.receipt;
    assert.equal(receipt?.status, "PASS");
    for (const name of ["reviewId", "artifactId", "runId", "operation"]) assert.match(receipt[name], UUID);
    assert.equal(receipt.runId, receipt.artifactId);
    assert.equal(receipt.durableResult?.reviewId, receipt.reviewId);
    assert.equal(receipt.durableResult?.artifactId, receipt.artifactId);
    assert.equal(receipt.durableResult?.version, 2);
    assert.match(receipt.durableResult.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(receipt.durableResult.bytes)
      && receipt.durableResult.bytes > 0 && receipt.durableResult.bytes <= 1048576);
    return { stage, reviewId: receipt.reviewId, artifactId: receipt.artifactId, runId: receipt.runId,
      operation: receipt.operation, durableResult: receipt.durableResult } as BusinessRecord;
  });
  for (const field of ["reviewId", "artifactId", "operation"] as const) {
    assert.equal(new Set(result.map(record => record[field])).size, stages.length);
  }
  return result;
}

export function businessRecoverySelections(records: BusinessRecord[]) {
  const reviews = literalIds(records.map(record => record.reviewId));
  const artifacts = literalIds(records.map(record => record.artifactId));
  const operations = literalIds(records.flatMap(record => [record.operation, record.artifactId]));
  return [
    ["public.starter_application", "singleton"],
    ["public.starter_members", `subject IN (SELECT owner_id FROM public.starter_reviews WHERE id IN (${reviews}))`],
    ["public.starter_reviews", `id IN (${reviews})`],
    ["public.starter_attachments", `review_id IN (${reviews})`],
    ["public.starter_attachment_results", `review_id IN (${reviews})`],
    ["storage.buckets", "id = 'review-attachments'"],
    ["storage.objects", `id IN (SELECT storage_object_id FROM supacloud_artifacts.artifacts WHERE id IN (${artifacts}))`],
    ["supacloud_artifacts.artifacts", `id IN (${artifacts})`],
    ["supacloud_commands.execution_receipts", `operation_key IN (${operations}) AND tenant_id = 'business-${RECOVERY_SOURCE_REF}'`],
    ["supacloud_commands.execution_audit", `operation_key IN (${operations}) AND tenant_id = 'business-${RECOVERY_SOURCE_REF}'`],
    ["supacloud_workflows.runs", `id IN (${artifacts})`],
    ["supacloud_workflows.steps", `run_id IN (${artifacts})`],
    ["supacloud_workflows.events", `run_id IN (${artifacts})`],
    ["pgmq.q_supacloud_internal_workflows", `message->>'run_id' IN (${artifacts})`],
    ["pgmq.a_supacloud_internal_workflows", `message->>'run_id' IN (${artifacts})`],
  ] as const;
}

export function recoveryDatabaseName(runId: string, kind: "stage" | "target") {
  assert.match(runId, UUID);
  assert.ok(kind === "stage" || kind === "target");
  return `business_recovery_${kind}_${runId.replaceAll("-", "")}`;
}

export function verifyRecoveryBytes(bytes: Uint8Array, expected: { sha256: string; bytes: number }) {
  assert.equal(bytes.byteLength, expected.bytes);
  assert.equal(sha256(bytes), expected.sha256);
}

export function recoverySpaceBudget(selectedBytes: number, objectBytes: number, availableBytes: number) {
  assert.ok(Number.isSafeInteger(selectedBytes) && selectedBytes >= 0 && selectedBytes <= 16 * MIB,
    "Business row export exceeds the bounded drill budget");
  assert.ok(Number.isSafeInteger(objectBytes) && objectBytes > 0 && objectBytes <= 3 * MIB);
  const requiredBytes = 128 * MIB + selectedBytes * 12 + objectBytes * 4;
  assert.ok(availableBytes >= requiredBytes + 512 * MIB, "Insufficient space; preserve existing data");
  return { selectedBytes, objectBytes, requiredBytes, availableBytes, reserveBytes: 512 * MIB };
}

async function sqlRows(connection: SQL, table: string, where = "true"): Promise<string> {
  // PostgreSQL serializes timestamps and bigint values, without a JS number round-trip.
  const [row] = await connection.unsafe(
    `SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]'::jsonb)::text AS rows
     FROM (SELECT to_jsonb(t) AS value FROM ${relation(table)} t WHERE ${where}) source`,
  );
  assert.equal(typeof row?.rows, "string");
  return row.rows;
}

export function verifyBusinessSnapshot(tables: TableBackup[], records: BusinessRecord[]) {
  const rows = (table: string): JsonRow[] => {
    const entry = tables.find(item => item.table === table);
    assert.ok(entry, `Missing ${table}`);
    assert.equal(sha256(entry.rows), entry.sha256);
    const parsed = JSON.parse(entry.rows);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, entry.count);
    return parsed;
  };
  for (const table of ["public.starter_reviews", "public.starter_attachments", "public.starter_attachment_results",
    "supacloud_artifacts.artifacts", "storage.objects", "supacloud_workflows.runs", "supacloud_workflows.steps"]) {
    assert.equal(rows(table).length, records.length, `Incomplete ${table}`);
  }
  for (const table of ["supacloud_commands.execution_receipts", "supacloud_commands.execution_audit"]) {
    assert.equal(rows(table).length, records.length * 2);
  }
  assert.equal(rows("pgmq.q_supacloud_internal_workflows").length, 0);
  const application = rows("public.starter_application");
  assert.equal(application.length, 1);
  assert.equal(application[0]?.project_id, RECOVERY_SOURCE_REF);
  assert.equal(application[0]?.tenant_id, `business-${RECOVERY_SOURCE_REF}`);
  for (const record of records) {
    const review = rows("public.starter_reviews").find(row => row.id === record.reviewId);
    assert.equal(review?.state, "approved");
    assert.equal(review?.version, 2);
    const attachment = rows("public.starter_attachments").find(row => row.review_id === record.reviewId);
    assert.equal(attachment?.artifact_id, record.artifactId);
    assert.equal(attachment?.run_id, record.runId);
    const result = rows("public.starter_attachment_results").find(row => row.review_id === record.reviewId);
    assert.deepEqual(result?.result, record.durableResult);
    assert.equal(result?.writer_revision, record.stage === "upgraded" ? "v2" : "v1");
    const artifact = rows("supacloud_artifacts.artifacts").find(row => row.id === record.artifactId);
    assert.equal(artifact?.object_path, attachment?.object_path);
    assert.equal(artifact?.sha256, record.durableResult.sha256);
    assert.equal(Number(artifact?.size_bytes), record.durableResult.bytes);
    const object = rows("storage.objects").find(row => row.id === artifact?.storage_object_id);
    assert.equal(object?.name, artifact?.object_path);
    assert.equal(object?.bucket_id, "review-attachments");
    const run = rows("supacloud_workflows.runs").find(row => row.id === record.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.output, record.durableResult);
    const step = rows("supacloud_workflows.steps").find(row => row.run_id === record.runId);
    assert.equal(step?.status, "completed");
    const events = rows("supacloud_workflows.events").filter(row => row.run_id === record.runId);
    for (const type of ["run_started", "step_claimed", "step_completed", "run_completed"]) {
      assert.ok(events.some(row => row.event_type === type));
    }
    for (const [key, command] of [[record.operation, "review.approve"], [record.artifactId, "review.attach"]]) {
      const receipt = rows("supacloud_commands.execution_receipts").filter(row => row.operation_key === key);
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0]?.command, command);
      assert.equal(receipt[0]?.status, "confirmed");
      assert.equal(receipt[0]?.audit_state, "complete");
      assert.equal(rows("supacloud_commands.execution_audit").filter(row => row.operation_key === key).length, 1);
    }
  }
}

export async function runBusinessRecovery() {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.SUPACLOUD_BUSINESS_RECOVERY_TEST, "1");
  assert.equal(process.env.SUPACLOUD_TEST_PROJECT_REF, RECOVERY_SOURCE_REF);
  assert.ok(process.env.DATABASE_URL && process.env.SUPACLOUD_BUSINESS_RECEIPT);
  const bin = process.env.SUPACLOUD_RECOVERY_PG_BIN;
  assert.ok(bin && isAbsolute(bin), "Explicit PostgreSQL client directory required");
  const sourceReceipt = await readFile(process.env.SUPACLOUD_BUSINESS_RECEIPT, "utf8");
  const records = businessRecoveryRecords(JSON.parse(sourceReceipt));
  const sourceName = `supa_${RECOVERY_SOURCE_REF}`;
  const runId = crypto.randomUUID();
  const names = { stage: recoveryDatabaseName(runId, "stage"), target: recoveryDatabaseName(runId, "target") };
  const settings = new URL(process.env.DATABASE_URL);
  const connect = (database: string) => new SQL({
    hostname: settings.hostname, port: Number(settings.port || 5432),
    username: decodeURIComponent(settings.username), password: decodeURIComponent(settings.password),
    database, max: 1, connectionTimeout: 5,
  });
  const commandEnv = (database: string, readOnly = false) => ({
    PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp", LANG: "C.UTF-8",
    PGHOST: settings.hostname, PGPORT: settings.port || "5432", PGDATABASE: database,
    PGUSER: decodeURIComponent(settings.username), PGPASSWORD: decodeURIComponent(settings.password),
    PGOPTIONS: readOnly ? "-c default_transaction_read_only=on -c statement_timeout=60000" : "-c statement_timeout=60000",
  });
  const command = async (name: "pg_dump" | "pg_restore", args: string[], database: string, readOnly = false) => {
    const child = Bun.spawn([join(bin, name), ...args], {
      env: commandEnv(database, readOnly), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    try {
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0) {
        const failureCode = errors.includes("permission denied") ? "42501"
          : /relation .* does not exist/.test(errors) ? "42P01"
          : /function .* does not exist/.test(errors) ? "42883"
          : /schema .* does not exist/.test(errors) ? "3F000" : "RECOVERY_PG_COMMAND_FAILED";
        throw Object.assign(new Error("Recovery PostgreSQL command failed"), { code: failureCode });
      }
      return output.trim();
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  };
  const base = "/var/lib/supacloud-delivery-acceptance";
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "business-recovery-"));
  await chmod(root, 0o700);
  const backup = join(root, "backup"), restoredObjects = join(root, "restored-objects");
  await mkdir(backup, { mode: 0o700 });
  await mkdir(restoredObjects, { mode: 0o700 });
  const metadata = new SQL(process.env.DATABASE_URL, { max: 1, connectionTimeout: 5 });
  const source = connect(sourceName);
  const control = connect("postgres");
  const created = new Map<string, number>();
  let stage: SQL | undefined, target: SQL | undefined;
  let phase = "source-guard";
  let failed = false;
  let failureCode: string | undefined;
  const evidence: Record<string, unknown> = {};
  const cleanup: string[] = [];
  const started = Date.now();
  const freeBytes = async () => {
    const fs = await statfs(root);
    return fs.bavail * fs.bsize;
  };
  let budget: ReturnType<typeof recoverySpaceBudget> | undefined;
  const create = async (name: string) => {
    assert.ok(Object.values(names).includes(name));
    assert.notEqual(name, sourceName);
    assert.ok(budget);
    recoverySpaceBudget(budget.selectedBytes, budget.objectBytes, await freeBytes());
    await control.unsafe(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);
    const [identity] = await control`SELECT oid FROM pg_database WHERE datname=${name}`;
    created.set(name, Number(identity.oid));
    await control.unsafe(`COMMENT ON DATABASE ${identifier(name)} IS 'business-recovery:${runId}'`);
    await control.unsafe(`REVOKE CONNECT ON DATABASE ${identifier(name)} FROM PUBLIC`);
    const database = connect(name);
    const [current] = await database`SELECT current_database() AS name`;
    assert.equal(current.name, name);
    return database;
  };
  try {
    const [project] = await metadata`
      SELECT name,db_name,service_role_key FROM projects WHERE ref=${RECOVERY_SOURCE_REF} AND deleted_at IS NULL
    `;
    assert.ok(project?.name.startsWith("platform-app-acceptance-"));
    assert.equal(project.db_name, sourceName);
    const [identity] = await source`SELECT current_database() AS name,current_setting('server_version_num')::int AS version`;
    assert.equal(identity.name, sourceName);
    const major = Math.floor(identity.version / 10000);
    assert.match(await command("pg_dump", ["--version"], sourceName, true), new RegExp(`\\b${major}\\.`));
    assert.match(await command("pg_restore", ["--version"], sourceName, true), new RegExp(`\\b${major}\\.`));
    const origin = `https://${RECOVERY_SOURCE_REF}.api.localhost`;
    const service = createClient(origin, project.service_role_key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, origin);
        return fetch(request, { redirect: "error", signal: AbortSignal.timeout(15000) });
      }) as typeof fetch },
    });
    const selections = businessRecoverySelections(records);
    const tables: TableBackup[] = [], objects: ObjectBackup[] = [];
    phase = "source-snapshot";
    await source.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async tx => {
      const [snapshot] = await tx`SELECT pg_export_snapshot() AS id`;
      const [marker] = await tx`
        SELECT obj_description('public.starter_application'::regclass) AS marker
      `;
      assert.equal(marker.marker, "supacloud-platform-business-fixture-v1");
      let selectedBytes = 0;
      for (const [table, where] of selections) {
        const [size] = await tx.unsafe(
          `SELECT count(*)::int AS count,COALESCE(sum(pg_column_size(t)),0)::text AS bytes
           FROM ${relation(table)} t WHERE ${where}`,
        );
        assert.ok(size.count <= 10000, "Selected business record count exceeds the bounded drill budget");
        selectedBytes += Number(size.bytes);
      }
      const [size] = await tx`SELECT pg_database_size(current_database())::text AS bytes`;
      budget = recoverySpaceBudget(selectedBytes, records.reduce((sum, row) => sum + row.durableResult.bytes, 0), await freeBytes());
      evidence.sizePreflight = { ...budget, sourceDatabaseBytes: Number(size.bytes), wholeDatabaseDump: false };
      for (const [table, where] of selections) {
        const rows = await sqlRows(tx, table, where);
        assert.ok(Buffer.byteLength(rows) <= 16 * MIB);
        const [schema, name] = table.split(".");
        const columns = await tx`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema=${schema} AND table_name=${name} AND is_generated='NEVER'
          ORDER BY ordinal_position
        `;
        tables.push({ table, columns: columns.map((column: JsonRow) => String(column.column_name)),
          rows, count: JSON.parse(rows).length, sha256: sha256(rows) });
      }
      verifyBusinessSnapshot(tables, records);
      const schemaPath = join(backup, "source-schema.dump");
      await command("pg_dump", ["--format=custom", "--schema-only", "--section=pre-data",
        "--no-owner", "--no-privileges", `--snapshot=${snapshot.id}`, "--file", schemaPath,
        ...selections.flatMap(([table]) => ["--table", table])], sourceName, true);
      await chmod(schemaPath, 0o600);
      assert.ok((await stat(schemaPath)).size <= 16 * MIB, "Selected table schema archive exceeds budget");
      for (const record of records) {
        const artifact: JsonRow = JSON.parse(tables.find(table => table.table === "supacloud_artifacts.artifacts")!.rows)
          .find((row: JsonRow) => row.id === record.artifactId);
        assert.equal(artifact.bucket_id, "review-attachments");
        assert.equal(typeof artifact.object_path, "string");
        const downloaded = await service.storage.from("review-attachments").download(artifact.object_path as string);
        assert.ok(!downloaded.error && downloaded.data, "Source Storage object read failed");
        const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
        verifyRecoveryBytes(bytes, record.durableResult);
        const file = `${record.artifactId}.bin`;
        await writeFile(join(backup, file), bytes, { flag: "wx", mode: 0o600 });
        objects.push({ artifactId: record.artifactId, bucketId: "review-attachments",
          objectPath: artifact.object_path as string, file, bytes: bytes.length, sha256: sha256(bytes) });
      }
    });
    // All subsequent restoration reads private backup files, never the live source connection.
    await source.close();
    const exported = JSON.stringify({ records, tables, objects });
    assert.ok(Buffer.byteLength(exported) <= 32 * MIB);
    await writeFile(join(backup, "business.json"), exported, { flag: "wx", mode: 0o600 });
    const exportHash = sha256(exported);
    evidence.sourceReceiptSha256 = sha256(sourceReceipt);
    evidence.businessExportSha256 = exportHash;
    evidence.sourceReadOnlySnapshot = true;
    phase = "isolated-staging";
    stage = await create(names.stage);
    for (const schema of new Set(selections.map(([table]) => table.split(".")[0]!))) {
      if (schema !== "public") await stage.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    }
    phase = "staging-schema";
    await command("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
      "--dbname", names.stage, join(backup, "source-schema.dump")], names.stage);
    const saved = await readFile(join(backup, "business.json"), "utf8");
    assert.equal(sha256(saved), exportHash);
    const input = JSON.parse(saved) as { records: BusinessRecord[]; tables: TableBackup[]; objects: ObjectBackup[] };
    await stage.begin(async tx => {
      for (const table of input.tables) {
        phase = `staging-data:${table.table}`;
        assert.equal(sha256(table.rows), table.sha256);
        const columns = table.columns.map(identifier).join(",");
        await tx.unsafe(`INSERT INTO ${relation(table.table)} (${columns}) OVERRIDING SYSTEM VALUE
          SELECT ${columns} FROM jsonb_populate_recordset(NULL::${relation(table.table)}, $1::text::jsonb)`, [table.rows]);
        assert.equal(await sqlRows(tx, table.table), table.rows, `Staging mismatch: ${table.table}`);
      }
    });
    phase = "logical-backup";
    const dump = join(backup, "business.dump");
    await command("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dump], names.stage, true);
    await chmod(dump, 0o600);
    assert.ok((await stat(dump)).size <= 64 * MIB, "Scoped business archive exceeds budget");
    const dumpHash = sha256(await readFile(dump));
    evidence.databaseArchiveSha256 = dumpHash;
    await stage.close();
    stage = undefined;
    phase = "independent-restore";
    target = await create(names.target);
    assert.equal(sha256(await readFile(dump)), dumpHash);
    await command("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
      "--dbname", names.target, dump], names.target);
    await target.close();
    target = connect(names.target);
    const [targetIdentity] = await target`SELECT current_database() AS name`;
    assert.equal(targetIdentity.name, names.target);
    const recovered: TableBackup[] = [];
    for (const table of input.tables) {
      const rows = await sqlRows(target, table.table);
      assert.equal(sha256(rows), table.sha256, `Recovered mismatch: ${table.table}`);
      recovered.push({ ...table, rows });
    }
    verifyBusinessSnapshot(recovered, input.records);
    evidence.tables = recovered.map(table => ({ table: table.table, count: table.count, sha256: table.sha256 }));
    evidence.actualBusinessRowsRestored = true;
    phase = "object-restore";
    for (const object of input.objects) {
      const bytes = await readFile(join(backup, object.file));
      verifyRecoveryBytes(bytes, object);
      await copyFile(join(backup, object.file), join(restoredObjects, object.file));
      await chmod(join(restoredObjects, object.file), 0o600);
      verifyRecoveryBytes(await readFile(join(restoredObjects, object.file)), object);
      const [artifact]: { sha256: string; size_bytes: number; object_path: string }[] = await target`
        SELECT sha256,size_bytes::int,object_path FROM supacloud_artifacts.artifacts WHERE id=${object.artifactId}::uuid
      `;
      assert.equal(artifact.sha256, object.sha256);
      assert.equal(artifact.size_bytes, object.bytes);
      assert.equal(artifact.object_path, object.objectPath);
    }
    evidence.objects = input.objects.map(({ artifactId, bytes, sha256 }) => ({ artifactId, bytes, sha256 }));
    evidence.storageBytesRestoredAndBoundToRegistry = true;
    evidence.independentTargetReadback = true;
    phase = "complete";
  } catch (error) {
    failed = true;
    const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const known = new Set(["42P01", "42883", "3F000", "42501", "23502", "23505", "428C9",
      "22P02", "22023", "42703", "ERR_ASSERTION", "RECOVERY_PG_COMMAND_FAILED"]);
    const code = [item.errno, item.code].find(value => typeof value === "string" && known.has(value));
    failureCode = typeof code === "string" ? code : "RECOVERY_FAILED";
  } finally {
    for (const connection of [stage, target, source, metadata]) {
      try { await connection?.close({ timeout: 5 }); } catch { cleanup.push("connection"); }
    }
    for (const [name, oid] of [...created].reverse()) {
      try {
        assert.ok(Object.values(names).includes(name));
        assert.notEqual(name, sourceName);
        const [owned] = await control`
          SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${name}
        `;
        assert.equal(Number(owned?.oid), oid);
        assert.equal(owned?.marker, `business-recovery:${runId}`);
        await control.unsafe(`DROP DATABASE ${identifier(name)}`);
        assert.equal((await control`SELECT oid FROM pg_database WHERE datname=${name}`).length, 0);
      } catch { cleanup.push(`database:${name}`); }
    }
    try { await control.close({ timeout: 5 }); } catch { cleanup.push("control-connection"); }
  }
  evidence.cleanupOwnedDatabases = cleanup.length === 0;
  evidence.createdDatabaseCount = created.size;
  const receipt = {
    status: failed || cleanup.length ? "FAIL" : "PASS", runId, phase, failureCode, root, sourceRef: RECOVERY_SOURCE_REF,
    targetDatabase: names.target, evidence, cleanup, elapsedMs: Date.now() - started,
    scope: "receipt-scoped-real-business-data-logical-recovery",
    restorationScope: "actual-business-records-and-object-bytes-only",
    fullApplicationDataRecovery: "PARTIAL",
    fullPlatformRecovery: "PARTIAL",
    exclusions: ["RLS", "roles-and-privileges", "functions", "triggers", "foreign-keys",
      "indexes-and-post-data-constraints", "service-reconstruction", "live-Storage-route-and-bucket-reconstruction",
      "Auth-users-and-secrets", "PITR-and-production-RPO-RTO"],
    retention: "private-backup-and-restored-object-bytes-retained",
    boundaries: ["not-PITR", "not-full-tenant-restore", "schema-table-shapes-and-data-only",
      "no-auth-secrets-roles-RLS-or-trigger-restoration", "objects-restored-to-isolated-files-not-S3-endpoint",
      "no-production-RPO-RTO-claim", "source-never-mutated"],
  };
  await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return receipt;
}

if (import.meta.main) {
  try {
    const receipt = await runBusinessRecovery();
    console.log(JSON.stringify(receipt));
    if (receipt.status !== "PASS") process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ status: "FAIL", code: "BUSINESS_RECOVERY_PREFLIGHT_OR_RECEIPT_FAILED" }));
    process.exitCode = 1;
  }
}
