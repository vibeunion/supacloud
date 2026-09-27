import { expect, test } from "bun:test";
import {
  classifyBusinessMigration, hasSchemaRefusal, limitedFailure, verifyBusinessResult,
} from "../fixtures/platform-business-launcher";

const source = await Bun.file(new URL("../fixtures/platform-business-launcher.ts", import.meta.url)).text();

test("temporary logins receive only tenant database CONNECT and cleanup revokes it independently", () => {
  const grant = 'await db.unsafe(`GRANT CONNECT ON DATABASE "supa_${ref}" TO "${name}"`)';
  const revoke = 'await db?.unsafe(`REVOKE CONNECT ON DATABASE "supa_${ref}" FROM "${name}"`)';
  expect(source).toContain(grant);
  expect(source.indexOf("roleNames.push(name)")).toBeLessThan(source.indexOf(grant));
  expect(source).toContain(revoke);
  expect(source).toContain('catch { cleanup.push("runtime-connect"); }');
  expect(source.indexOf(revoke)).toBeGreaterThan(source.indexOf('catch { cleanup.push("runtime-login"); }'));
  expect(source).not.toContain("GRANT ALL");
  expect(source).not.toContain("GRANT USAGE ON SCHEMA");
});
const columns = [
  { table_name: "starter_application", column_name: "delivery_revision", data_type: "integer",
    column_default: "2", is_nullable: "NO" },
  { table_name: "starter_attachment_results", column_name: "writer_revision", data_type: "text",
    column_default: "'v1'::text", is_nullable: "NO" },
];

test("migration state distinguishes fresh schema, complete retry and partial installation", () => {
  expect(classifyBusinessMigration([])).toBe("absent");
  expect(classifyBusinessMigration(columns)).toBe("applied");
  for (const partial of [columns.slice(0, 1), columns.slice(1), [...columns, columns[0]!]]) {
    expect(() => classifyBusinessMigration(partial)).toThrow("BUSINESS_MIGRATION_PARTIAL");
  }
});

test("migration verification rejects incompatible defaults, types and nullability", () => {
  for (const mutation of [
    { column_default: "12" }, { column_default: "NULL" }, { data_type: "text" }, { is_nullable: "YES" },
  ]) {
    expect(() => classifyBusinessMigration([{ ...columns[0]!, ...mutation }, columns[1]!])).toThrow();
  }
  for (const mutation of [
    { column_default: "'v2'::text" }, { column_default: "'v1'::text || 'changed'" },
    { data_type: "character varying" }, { is_nullable: "YES" },
  ]) {
    expect(() => classifyBusinessMigration([columns[0]!, { ...columns[1]!, ...mutation }])).toThrow();
  }
});

test("schema refusal requires the exact marker from the selected unit invocation", () => {
  const entry = {
    _SYSTEMD_UNIT: "candidate-api.service", _SYSTEMD_INVOCATION_ID: "current-invocation", _PID: "123",
    MESSAGE: JSON.stringify({ event: "reference-schema-rejected", reason: "missing-revision" }),
  };
  const accepts = (value: object) => hasSchemaRefusal(JSON.stringify(value), entry._SYSTEMD_UNIT, entry._SYSTEMD_INVOCATION_ID);
  expect(accepts(entry)).toBe(true);
  expect(accepts({ ...entry, _SYSTEMD_INVOCATION_ID: "previous-invocation" })).toBe(false);
  expect(accepts({ ...entry, _SYSTEMD_UNIT: "different-api.service" })).toBe(false);
  expect(accepts({ ...entry, _PID: "0" })).toBe(false);
  expect(accepts({ ...entry, MESSAGE: "Delivery HTTP startup failed." })).toBe(false);
  expect(accepts({ ...entry, MESSAGE: JSON.stringify({ event: "reference-schema-rejected", reason: "permission-denied" }) })).toBe(false);
  expect(hasSchemaRefusal("not-json\nnull", entry._SYSTEMD_UNIT, entry._SYSTEMD_INVOCATION_ID)).toBe(false);
});

test("durable readback validates exact content, receipt IDs and writer revision", () => {
  const receipt = { label: "upgraded", reviewId: "review", artifactId: "artifact",
    durableResult: { reviewId: "review", artifactId: "artifact", version: 2, sha256: "digest", bytes: 4 } };
  const row = { review_id: "review", artifact_id: "artifact", version: 2,
    result: receipt.durableResult, writer_revision: "v2" };
  expect(() => verifyBusinessResult(receipt, [row], "v2")).not.toThrow();
  expect(() => verifyBusinessResult(receipt, [], "v2")).toThrow();
  expect(() => verifyBusinessResult(receipt, [row, row], "v2")).toThrow();
  expect(() => verifyBusinessResult(receipt, [row], "v1")).toThrow();
  expect(() => verifyBusinessResult(receipt, [{ ...row, result: { ...receipt.durableResult, bytes: 5 } }], "v2")).toThrow();
  for (const mutation of [{ review_id: "foreign" }, { artifact_id: "foreign" }, { version: 3 }]) {
    expect(() => verifyBusinessResult(receipt, [{ ...row, ...mutation }], "v2")).toThrow();
  }
  expect(() => verifyBusinessResult({ ...receipt, reviewId: "foreign" }, [row], "v2")).toThrow();
  expect(() => verifyBusinessResult({ ...receipt, artifactId: "foreign" }, [row], "v2")).toThrow();
});

test("launcher verifies per-run v1-v2-v1 durable contents without downgrading schema", () => {
  expect(source).toContain("verifyBusinessHistory");
  expect(source).toContain('const expectedRevisions = ["v1", "v2", "v1"]');
  expect(source).toContain("receipt.durableResult");
  expect(source).not.toContain("DROP COLUMN");
  expect(source).not.toContain("count(*)::int AS count FROM public.starter_attachment_results");
});

test("launcher diagnostics never copy arbitrary error fields or raw messages", () => {
  expect(limitedFailure({ name: "PostgresError", code: "42501", message: "sensitive SQL text" }))
    .toEqual({ name: "PostgresError", code: "42501" });
  expect(limitedFailure(new Error("APPLICATION_RUNTIME_START_FAILED")))
    .toEqual({ name: "Error", code: "APPLICATION_RUNTIME_START_FAILED" });
  for (const error of [null, "sensitive text", {
    name: "private-name", code: "private-token", message: "postgres://user:password@host",
  }]) expect(limitedFailure(error)).toEqual({ name: "Error", code: "UNKNOWN_ERROR" });
});

test("retry skips unavailable pre-migration proof without claiming it passed", () => {
  expect(source).toContain('if (beforeMigration === "absent") await expectUpgradeRefused(path)');
  expect(source).toContain('status: "NOT_RUN", reason: "schema-already-applied"');
  expect(source).toContain("await migrationState(tx)");
  expect(source).not.toContain('supacloud.platform-workflow-acceptance');
});
