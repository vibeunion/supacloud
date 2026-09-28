import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DeliveryMigrationArchive } from "@supacloud/delivery";
import { ApplicationMigrations } from "../../src/services/application-migrations";
import { createApplicationRoutes } from "../../src/routes/applications";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";
import { runtimeInput } from "../helpers/application-runtime";

const record = runtimeInput().release;
const statement = "CREATE TABLE public.example(id integer);\r\n";
function archive(target = "api"): DeliveryMigrationArchive {
  return {
    target, objectId: record.targets.find(entry => entry.name === target)!.object_id,
    artifactVerified: true,
    migrations: [{
      version: "1", name: "example", executor: "project-migration", path: "migrations/project-migration/1_example.sql",
      sha256: createHash("sha256").update(statement).digest("hex"), bytes: Buffer.byteLength(statement), sql: statement,
    }],
  };
}

function row(version = "1", sql = statement, name = "example") {
  return {
    version, name, statements: [sql.trim()], statement_count: 1,
    checksum: calculateMigrationChecksum({ version, name, statements: [sql] }),
    applied_at: null,
  };
}

function service(archives = [archive(), archive("jobs")], rows: ReturnType<typeof row>[] = []) {
  return new ApplicationMigrations({
    storage: { readMigrations: async () => ({ record, archives }) },
    inventory: async () => rows,
  });
}

test("application migration report compares all targets without claiming semantic compatibility", async () => {
  const pending = await service().inspect("demo", "reviews", record.release_id);
  expect(pending.project_migrations_applied).toBe(false);
  expect(pending.ledger_compatible).toBe(true);
  expect(pending.targets.map(target => target.migrations[0]?.status)).toEqual(["pending", "pending"]);
  const applied = await service(undefined, [row()]).inspect("demo", "reviews", record.release_id);
  expect(applied.project_migrations_applied).toBe(true);
  expect(applied).toMatchObject({
    project_ref: "demo", application_id: "reviews", release_id: record.release_id,
    compatibility: "not-proven", execution_performed: false, data_recovery: "separate-required",
  });
  expect(applied.ledger_digest).not.toBe(pending.ledger_digest);
  expect(JSON.stringify(applied)).not.toContain("CREATE TABLE");
  expect(JSON.stringify(applied)).not.toContain("statements");
});

test("cross-target version, executor and name conflicts are application conflicts", async () => {
  const api = archive(), jobs = archive("jobs");
  for (const patch of [
    { sha256: "d".repeat(64) }, { executor: "operator-provisioning" as const }, { name: "other" }, { version: "2" },
  ]) {
    const changed = structuredClone(jobs);
    Object.assign(changed.migrations[0]!, patch);
    const report = await service([api, changed], [row()]).inspect("demo", "reviews", record.release_id);
    expect(report.ledger_compatible).toBe(false);
    expect(report.project_migrations_applied).toBe(false);
    expect(report.declaration_conflicts).toContain("1");
  }
});

test("mismatched or out-of-order ledger entries do not appear applied", async () => {
  for (const rows of [[row("1", "SELECT 1")], [row("2", "SELECT 2", "later")], [row("2")]]) {
    const report = await service(undefined, rows).inspect("demo", "reviews", record.release_id);
    expect(report.ledger_compatible).toBe(false);
    expect(report.project_migrations_applied).toBe(false);
  }
});

test("operator provisioning never becomes verified by a project migration match", async () => {
  const provisioning = archive();
  provisioning.migrations[0]!.executor = "operator-provisioning";
  const report = await service([provisioning], [row()]).inspect("demo", "reviews", record.release_id);
  expect(report.operator_provisioning).toBe("separate-verification-required");
  expect(report.targets[0]?.operatorProvisioning[0]?.status).toBe("separate-verification-required");
  expect(report.compatibility).toBe("not-proven");
});

test("migration reads authorize before touching archives or project SQL and redact failures", async () => {
  let reads = 0;
  const app = createApplicationRoutes({
    projectExists: async () => true,
    authorize: async request => request.headers.get("authorization") === "Bearer local-test"
      ? undefined : { status: 403, body: { error: "Denied" } },
    migrations: { inspect: async () => { reads++; throw new Error("private SQL connection detail"); } },
  });
  const url = `http://localhost/v1/projects/demo/applications/reviews/releases/${record.release_id}/migrations`;
  expect((await app.handle(new Request(url))).status).toBe(403);
  expect(reads).toBe(0);
  const response = await app.handle(new Request(url, { headers: { authorization: "Bearer local-test" } }));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private SQL");
  expect(reads).toBe(1);
  const readable = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined, migrations: service(undefined, [row()]),
  });
  const valid = await readable.handle(new Request(url));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({ project_migrations_applied: true, compatibility: "not-proven" });
});
