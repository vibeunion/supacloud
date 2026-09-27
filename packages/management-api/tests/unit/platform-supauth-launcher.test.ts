import { expect, test } from "bun:test";
import {
  AcceptanceFailure, checkLedger, classifyDenial, cleanupAll, guardTarget, MACHINE, migrationChecksum,
  safeFailure, SOURCE_SHA, TARGET, validateArtifact,
} from "../fixtures/platform-supauth-launcher";

const project = { ref: TARGET, name: "platform-app-acceptance-unit", db_name: `supa_${TARGET}` };
const plan = ["1", ...Array.from({ length: 15 }, (_, i) => String(i + 4))].map(version => {
  const m = { version, name: `supauth-overlay-unit-v${version}`, sql: "\nSELECT 1;\n" };
  return { ...m, checksum: migrationChecksum(m) };
});
const artifact = { sourceSha: SOURCE_SHA, emulatorSha256: "a".repeat(64), migrations: plan };

test("target guards reject non-acceptance machine, ref, name, database and missing opt-in", () => {
  expect(() => guardTarget(MACHINE, "linux", "1", project)).not.toThrow();
  for (const args of [
    ["production", "linux", "1", project],
    [MACHINE, "darwin", "1", project],
    [MACHINE, "linux", undefined, project],
    [MACHINE, "linux", "1", { ...project, ref: "another" }],
    [MACHINE, "linux", "1", { ...project, name: "business" }],
    [MACHINE, "linux", "1", { ...project, db_name: "postgres" }],
  ] as const) expect(() => guardTarget(args[0], args[1], args[2], args[3])).toThrow();
});

test("artifact checks source, ordered versions and original SQL checksum", () => {
  expect(() => validateArtifact(artifact)).not.toThrow();
  expect(() => validateArtifact({ ...artifact, sourceSha: "unknown" })).toThrow();
  expect(() => validateArtifact({ ...artifact, migrations: plan.slice(1) })).toThrow();
  expect(() => validateArtifact({
    ...artifact, migrations: plan.map((m, i) => i ? m : { ...m, sql: "SELECT 2;" }),
  })).toThrow();
});

test("ledger requires exact source statements, versions, names and checksums", () => {
  const rows = plan.map(m => ({ ...m, statements: [m.sql.trim()] }));
  expect(() => checkLedger(plan, [], false)).not.toThrow();
  expect(() => checkLedger(plan, [], true)).toThrow();
  expect(() => checkLedger(plan, rows, true)).not.toThrow();
  for (const patch of [
    { name: "business-v1" }, { version: "100" }, { checksum: "bad" }, { statements: ["SELECT 2;"] },
  ]) expect(() => checkLedger(plan, [{ ...rows[0]!, ...patch }, ...rows.slice(1)], true)).toThrow();
  expect(() => checkLedger(plan, [...rows, rows[0]!], true)).toThrow();
});

test("failures never serialize upstream credential-bearing messages", () => {
  expect(safeFailure(new Error("password=secret"), "login")).toEqual({ stage: "login" });
  expect(safeFailure(new AcceptanceFailure("request", 403), "delegation"))
    .toEqual({ stage: "delegation", status: 403 });
  expect(classifyDenial("The current principal is not an active project collaborator; secret"))
    .toBe("actor_not_project_collaborator");
  expect(classifyDenial("password=secret")).toBe("unclassified_upstream_failure");
});

test("cleanup runs remaining actions even when session cleanup fails", async () => {
  const calls: string[] = [];
  await expect(cleanupAll([
    async () => { calls.push("session"); throw new Error("upstream credential"); },
    async () => { calls.push("process"); },
    async () => { calls.push("lock"); },
  ])).rejects.toThrow("cleanup");
  expect(calls).toEqual(["session", "process", "lock"]);
});
