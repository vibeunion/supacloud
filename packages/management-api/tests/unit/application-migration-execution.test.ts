import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DeliveryMigrationArchive } from "@supacloud/delivery";
import { ApplicationMigrations } from "../../src/services/application-migrations";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";
import type { LogicalBackupIdentity } from "../../src/types/backup";
import { stableSha256 } from "../../src/utils/stable-json";
import { runtimeInput } from "../helpers/application-runtime";

const now = Date.parse("2026-10-11T05:00:00.000Z");
const record = runtimeInput().release;
const backupId = `logical-full_demo_${"1".repeat(32)}`;
const initialSql = "CREATE TABLE public.example(id integer);\r\n";

function migration(version = "1", sql = initialSql, name = `example_${version}`) {
  return {
    version, sql, name, path: `migrations/project-migration/${version}_${name}.sql`,
    bytes: Buffer.byteLength(sql), sha256: createHash("sha256").update(sql).digest("hex"),
    executor: "project-migration" as const,
  };
}

function ledger(entry: ReturnType<typeof migration>) {
  return {
    version: entry.version, name: entry.name, statements: [entry.sql], statement_count: 1, applied_at: null,
    checksum: calculateMigrationChecksum({ version: entry.version, name: entry.name, statements: [entry.sql] }),
  };
}

function fixture(entries = [migration()]) {
  const archives: DeliveryMigrationArchive[] = ["api", "jobs"].map(target => ({
    target, objectId: record.targets.find(entry => entry.name === target)!.object_id, artifactVerified: true,
    migrations: structuredClone(entries),
  }));
  const rows: ReturnType<typeof ledger>[] = [];
  const calls: string[] = [];
  const backup: LogicalBackupIdentity = {
    backup_id: backupId, project_ref: "demo", database: "supa_demo", kind: "logical-full",
    created_at: new Date(now - 10_000).toISOString(), completed_at: new Date(now - 1000).toISOString(),
    bytes: 1024, sha256: "e".repeat(64),
  };
  let inLock = false;
  let failCreate = false, mismatchedRead = false, omitLedger = false, badReceipt = false, failExecute = false;
  let driftOnBackup = false, extraOnExecute = false, noProject = false;
  const service = new ApplicationMigrations({
    storage: { readMigrations: async () => ({ record: noProject ? { ...record, project_ref: "foreign" } : record, archives }) },
    inventory: async () => structuredClone(rows),
    now: () => now,
    withLock: async (_input, action) => {
      inLock = true;
      calls.push("lock");
      try { return await action(); }
      finally { inLock = false; calls.push("unlock"); }
    },
    backups: {
      create: async (ref, id) => {
        expect(inLock).toBe(true);
        expect([ref, id]).toEqual(["demo", backupId]);
        calls.push("backup-create");
        if (failCreate) throw new Error("Synthetic durable publication failure");
        if (driftOnBackup) rows.push(ledger(migration("3", "SELECT 3;", "foreign")));
        return structuredClone(backup);
      },
      read: async (ref, id) => {
        expect(inLock).toBe(true);
        expect([ref, id]).toEqual(["demo", backupId]);
        calls.push("backup-read");
        return { ...backup, ...(mismatchedRead ? { sha256: "d".repeat(64) } : {}) };
      },
    },
    execute: async input => {
      expect(inLock).toBe(true);
      expect(input.projectRef).toBe("demo");
      expect(input.conflictOnName).toBe(true);
      expect(input.statements).toHaveLength(1);
      calls.push(`sql-${input.version}`);
      if (failExecute) throw new Error("postgres://secret:password@private-host SQL error");
      const entry = entries.find(entry => entry.version === input.version)!;
      if (!omitLedger) rows.push(ledger(entry));
      if (extraOnExecute) rows.push(ledger(migration("3", "SELECT 3;", "foreign")));
      return {
        checksum: badReceipt ? "d".repeat(64) : calculateMigrationChecksum(input),
        alreadyApplied: false, strippedTransactionWrappers: 0,
      };
    },
  });
  const input = {
    projectRef: "demo", applicationId: "reviews", releaseId: record.release_id,
    expectedLedgerDigest: stableSha256([]), backupId,
  };
  return {
    service, input, rows, archives, calls, backup,
    failCreate: () => { failCreate = true; },
    mismatch: () => { mismatchedRead = true; },
    omitLedger: () => { omitLedger = true; },
    badReceipt: () => { badReceipt = true; },
    driftOnBackup: () => { driftOnBackup = true; },
    extraOnExecute: () => { extraOnExecute = true; },
    wrongRelease: () => { noProject = true; },
    failExecute: () => { failExecute = true; },
  };
}

test("execution plan is pure and does not expose archived SQL or database credentials", async () => {
  const f = fixture();
  const plan = await f.service.readExecutionPlan(f.input);
  expect(plan).toMatchObject({
    project_ref: "demo", ledger_compatible: true, backup_required: true,
    destructive_confirmation_required: false, execution_performed: false,
  });
  expect(plan.migrations).toHaveLength(1);
  expect(f.calls).toEqual([]);
  expect(JSON.stringify(plan)).not.toContain("CREATE TABLE");
  expect(JSON.stringify(plan)).not.toContain("supa_demo");
  const { plan_sha256, ...content } = plan;
  expect(plan_sha256).toBe(stableSha256(content));
});

test("pending migrations are deduplicated and numerically ordered under one backup-to-readback lock", async () => {
  const f = fixture([migration("2", "ALTER TABLE public.example ADD COLUMN note text;"), migration()]);
  const result = await f.service.apply(f.input);
  expect(f.calls).toEqual(["lock", "backup-create", "backup-read", "sql-1", "sql-2", "unlock"]);
  expect(result.applied.map(entry => entry.version)).toEqual(["1", "2"]);
  expect(result.backup).toEqual(f.backup);
  expect(result.before.project_migrations_applied).toBe(false);
  expect(result.after.project_migrations_applied).toBe(true);
  expect(JSON.stringify(result)).not.toContain("CREATE TABLE");
});

test("already-applied migrations have no backup or SQL effects", async () => {
  const f = fixture();
  f.rows.push(ledger(migration()));
  const plan = await f.service.readExecutionPlan(f.input);
  const result = await f.service.apply({ ...f.input, expectedLedgerDigest: plan.ledger_digest });
  expect(result.applied).toEqual([]);
  expect(result.backup).toBeNull();
  expect(f.calls).toEqual(["lock", "unlock"]);
});

test.each(["ledger", "declaration", "release", "backup-id"] as const)(
  "%s mismatch rejects execution before backup or SQL", async fault => {
    const f = fixture();
    if (fault === "ledger") f.input.expectedLedgerDigest = "d".repeat(64);
    if (fault === "declaration") f.archives[1]!.migrations[0]!.name = "conflicting";
    if (fault === "release") f.wrongRelease();
    if (fault === "backup-id") f.input.backupId = `logical-full_foreign_${"1".repeat(32)}`;
    await expect(f.service.apply(f.input)).rejects.toBeDefined();
    expect(f.calls).toEqual(["lock", "unlock"]);
  },
);

test.each(["failed-create", "readback", "stale", "future", "empty", "ledger-drift"] as const)(
  "%s backup never permits SQL", async fault => {
    const f = fixture();
    if (fault === "failed-create") f.failCreate();
    if (fault === "readback") f.mismatch();
    if (fault === "stale") f.backup.completed_at = new Date(now - 31 * 60_000).toISOString();
    if (fault === "future") f.backup.completed_at = new Date(now + 1000).toISOString();
    if (fault === "empty") f.backup.bytes = 0;
    if (fault === "ledger-drift") f.driftOnBackup();
    await expect(f.service.apply(f.input)).rejects.toBeDefined();
    expect(f.calls.some(call => call.startsWith("sql-"))).toBe(false);
    expect(f.calls.at(-1)).toBe("unlock");
  },
);

test("operator provisioning is never run with the project migration role", async () => {
  const f = fixture();
  for (const archive of f.archives) archive.migrations[0]!.executor = "operator-provisioning";
  await expect(f.service.apply(f.input)).rejects.toMatchObject({ code: "APPLICATION_OPERATOR_PROVISIONING_REQUIRED" });
  expect(f.calls).toEqual(["lock", "unlock"]);
});

test.each(["VACUUM public.example;", "CREATE INDEX CONCURRENTLY idx ON public.example(id);", "ALTER ROLE postgres SUPERUSER;"])(
  "unsupported SQL %s cannot pass even with a reviewed digest", async statement => {
    const f = fixture([migration("1", statement)]);
    const plan = await f.service.readExecutionPlan(f.input);
    await expect(f.service.apply({ ...f.input, approvedMigrationDigest: plan.plan_sha256 }))
      .rejects.toMatchObject({ code: "APPLICATION_MIGRATION_SQL_UNSUPPORTED" });
    expect(f.calls).toEqual(["lock", "unlock"]);
  },
);

test("destructive SQL requires approval of this exact archive-and-ledger plan", async () => {
  const f = fixture([migration("1", "DELETE FROM public.example;")]);
  const plan = await f.service.readExecutionPlan(f.input);
  expect(plan.destructive_confirmation_required).toBe(true);
  for (const approvedMigrationDigest of [undefined, "f".repeat(64)]) {
    await expect(f.service.apply({ ...f.input, approvedMigrationDigest }))
      .rejects.toMatchObject({ code: "APPLICATION_MIGRATION_REVIEW_REQUIRED" });
  }
  expect(f.calls.filter(call => call === "backup-create")).toHaveLength(0);
  expect((await f.service.apply({ ...f.input, approvedMigrationDigest: plan.plan_sha256 })).after.project_migrations_applied)
    .toBe(true);
});

test.each(["receipt", "missing-ledger", "extra-ledger"] as const)(
  "%s after SQL is not a successful batch", async fault => {
    const f = fixture();
    if (fault === "receipt") f.badReceipt();
    if (fault === "missing-ledger") f.omitLedger();
    if (fault === "extra-ledger") f.extraOnExecute();
    await expect(f.service.apply(f.input)).rejects.toMatchObject({
      code: fault === "receipt" ? "APPLICATION_MIGRATION_RECEIPT_MISMATCH" : "APPLICATION_MIGRATION_READBACK_FAILED",
      statusCode: 503,
    });
    expect(f.calls.filter(call => call === "sql-1")).toHaveLength(1);
  },
);

test("an uncertain SQL result is redacted and never automatically retried or restored", async () => {
  const f = fixture();
  f.failExecute();
  await expect(f.service.apply(f.input)).rejects.toMatchObject({
    code: "APPLICATION_MIGRATION_OUTCOME_UNKNOWN", message: "APPLICATION_MIGRATION_OUTCOME_UNKNOWN",
  });
  expect(f.calls).toEqual(["lock", "backup-create", "backup-read", "sql-1", "unlock"]);
});
