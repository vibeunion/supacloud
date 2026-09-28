import { expect, test } from "bun:test";
import {
  RECOVERY_SOURCE_REF, businessRecoveryRecords, businessRecoverySelections,
  recoveryDatabaseName, recoverySpaceBudget, verifyRecoveryBytes,
} from "../fixtures/platform-business-recovery";
import { sha256 } from "../../src/services/restore-drill-contract";

function receipt() {
  const evidence: Record<string, unknown> = { rollbackPreservedData: true };
  for (const stage of ["original", "upgraded", "rollback"]) {
    const reviewId = crypto.randomUUID(), artifactId = crypto.randomUUID();
    evidence[stage] = {
      readiness: { ready: true, project_ref: RECOVERY_SOURCE_REF },
      receipt: { status: "PASS", reviewId, artifactId, runId: artifactId, operation: crypto.randomUUID(),
        durableResult: { reviewId, artifactId, version: 2, sha256: "a".repeat(64), bytes: 56 } },
    };
  }
  return { status: "PASS", evidence };
}

test("recovery selects the three completed real receipt chains, never Auth credentials", () => {
  const records = businessRecoveryRecords(receipt());
  expect(records.length).toBe(3);
  const selections = businessRecoverySelections(records);
  expect(selections.length).toBe(15);
  expect(selections.some(([name]) => name.startsWith("auth."))).toBe(false);
  for (const record of records) {
    expect(selections.find(([name]) => name === "public.starter_reviews")?.[1]).toContain(record.reviewId);
    expect(selections.find(([name]) => name === "supacloud_commands.execution_receipts")?.[1]).toContain(record.operation);
    expect(selections.find(([name]) => name === "supacloud_workflows.runs")?.[1]).toContain(record.artifactId);
  }
});

test("wrong project, failed receipt and forged row identifiers are refused", () => {
  const base = receipt();
  expect(() => businessRecoveryRecords({ ...base, status: "FAIL" })).toThrow();
  expect(() => businessRecoveryRecords({ ...base, evidence: { ...base.evidence, rollbackPreservedData: false } })).toThrow();
  const wrong = structuredClone(base) as any;
  wrong.evidence.original.readiness.project_ref = "other-project";
  expect(() => businessRecoveryRecords(wrong)).toThrow();
  const forged = structuredClone(base) as any;
  forged.evidence.original.receipt.reviewId = "'; DROP DATABASE postgres; --";
  expect(() => businessRecoveryRecords(forged)).toThrow();
  const duplicates = structuredClone(base) as any;
  duplicates.evidence.upgraded.receipt = duplicates.evidence.original.receipt;
  expect(() => businessRecoveryRecords(duplicates)).toThrow();
});

test("target names can only be new recovery namespaces, not source or arbitrary databases", () => {
  const runId = crypto.randomUUID();
  const stage = recoveryDatabaseName(runId, "stage"), target = recoveryDatabaseName(runId, "target");
  expect(stage).not.toBe(target);
  expect(target).not.toBe(`supa_${RECOVERY_SOURCE_REF}`);
  expect(target.length).toBeLessThanOrEqual(63);
  expect(() => recoveryDatabaseName("postgres", "target")).toThrow();
  expect(() => recoveryDatabaseName(runId, "source" as "target")).toThrow();
});

test("object bytes must match both actual length and the source registry SHA", () => {
  const bytes = new TextEncoder().encode("unit-test-only");
  const expected = { bytes: bytes.length, sha256: sha256(bytes) };
  expect(() => verifyRecoveryBytes(bytes, expected)).not.toThrow();
  expect(() => verifyRecoveryBytes(new Uint8Array(bytes.length), expected)).toThrow();
  expect(() => verifyRecoveryBytes(bytes.slice(1), expected)).toThrow();
});

test("space guard refuses large exports and preserves a 512 MiB reserve", () => {
  expect(recoverySpaceBudget(16000, 168, 3 * 1024 ** 3).requiredBytes).toBeGreaterThan(128 * 1024 ** 2);
  expect(() => recoverySpaceBudget(16000, 168, 512 * 1024 ** 2)).toThrow();
  expect(() => recoverySpaceBudget(17 * 1024 ** 2, 168, 10 * 1024 ** 3)).toThrow();
  expect(() => recoverySpaceBudget(16000, 4 * 1024 ** 2, 10 * 1024 ** 3)).toThrow();
});

test("source is a read-only snapshot and restore never cleans an existing database", async () => {
  const source = await Bun.file(new URL("../fixtures/platform-business-recovery.ts", import.meta.url)).text();
  expect(source).toContain('source.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY"');
  expect(source).toContain("pg_export_snapshot()");
  expect(source).toContain("$1::text::jsonb");
  expect(source).toContain("default_transaction_read_only=on");
  expect(source).toContain("shobj_description");
  expect(source).not.toContain("--clean");
  expect(source).not.toContain("DROP DATABASE IF EXISTS");
  expect(source).not.toContain("WITH (FORCE)");
  expect(source).not.toContain("rejectUnauthorized: false");
  expect(source).toContain('restorationScope: "actual-business-records-and-object-bytes-only"');
  expect(source).toContain('fullApplicationDataRecovery: "PARTIAL"');
  expect(source).toContain('fullPlatformRecovery: "PARTIAL"');
  expect(source).toContain("live-Storage-route-and-bucket-reconstruction");
});
