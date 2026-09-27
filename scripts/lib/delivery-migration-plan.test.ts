import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "../../packages/compiler/dist/index.js";
import { GOOD_PROJECT_FILES } from "../../packages/compiler/src/fixtures/good-project";
import { writeFixtureProject } from "../../packages/compiler/src/fixtures/helpers";
import { createMigrationLedgerEntry } from "../../packages/management-api/src/services/migration-promotion";
import { ensureMigrationLedgerMetadata, readMigrationInventory, readMigrationLedger } from "../../packages/management-api/src/services/migration-ledger";
import { registerDatabaseTools } from "../../packages/cli/src/shared/tools/database-tools";
import type { HttpResult, HttpTransport } from "../../packages/cli/src/shared/transports/http";
import { startStarterPostgres } from "./starter-postgres";

async function archiveFixture(root: string) {
  const sql = "CREATE TABLE public.delivery_check(id integer);\r\n-- private-sql-value\r\n";
  const operator = "CREATE ROLE delivery_operator NOLOGIN;\n";
  await writeFixtureProject(root, {
    ...GOOD_PROJECT_FILES,
    "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"].replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "migrations/review.sql": sql, "migrations/operator.sql": operator,
  });
  const built = await buildDeliveryProject({
    rootDir: join(root, "src"), outDir: join(root, "generated"), strict: false,
    generateClient: false, generatePermissions: false,
  }, { version: 1, build: { migrations: [
    { source: "migrations/review.sql", version: "1", name: "review", executor: "project-migration" },
    { source: "migrations/operator.sql", version: "2", name: "operator", executor: "operator-provisioning" },
  ] } });
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  await rm(join(root, "src"), { recursive: true });
  await rm(join(root, "migrations"), { recursive: true });
  return { sql, built, manifest: join(root, "generated/delivery/delivery.manifest.json") };
}

test("delivery migration planning verifies detached artifacts and canonical inventory without writing or disclosing SQL", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-migration-plan-"));
  try {
    const { sql, built, manifest } = await archiveFixture(root);
    const pointer = await readFile(manifest, "utf8");
    let response: HttpResult<unknown> = { ok: true, status: 200, data: [] };
    let responseRef = "test-project", readOnly = true;
    const requests: string[] = [];
    const http = {
      get: async (path: string, options: { maxResponseBytes?: number }) => {
        expect(options.maxResponseBytes).toBe(64 * 1024 * 1024);
        requests.push(path);
        return response.ok ? { ...response, data: {
          project_ref: responseRef, read_only: readOnly, migrations: response.data,
        } } : response;
      },
      post: async () => { throw new Error("Unexpected write"); },
      postReleaseMutation: async () => { throw new Error("Unexpected write"); },
    } as unknown as HttpTransport;
    type Result = { isError?: boolean; content: Array<{ text: string }> };
    let execute!: (args: Record<string, unknown>) => Promise<Result>;
    registerDatabaseTools({ tool(_name, _description, schema, callback) {
      expect(JSON.stringify(schema.action)).toContain("delivery_migration_plan");
      execute = callback;
    } }, http, { projectRef: "test-project", readOnly: true });
    const args = { action: "delivery_migration_plan", delivery_manifest: manifest, delivery_target: "api" };
    const invoke = async () => {
      const result = await execute(args);
      expect(result.content[0]!.text).not.toContain("private-sql-value");
      expect(await readFile(manifest, "utf8")).toBe(pointer);
      return { result, plan: JSON.parse(result.content[0]!.text) };
    };
    const pending = await invoke();
    expect(pending.result.isError).toBeUndefined();
    expect(pending.plan.migrations[0].status).toBe("pending");
    expect(pending.plan.operatorProvisioning[0].status).toBe("separate-verification-required");
    expect(pending.plan).toMatchObject({
      projectRef: "test-project", ledgerCompatible: true, executionPerformed: false,
      compatibility: "not-proven", deploymentVerified: false, dataRecovery: "separate-required",
    });
    const inventoryEntry = (version: string, name: string, statements: string[]) => {
      const entry = createMigrationLedgerEntry({ version, name, statements });
      return { version: entry.version, name: entry.name, statements: entry.statements,
        checksum: entry.checksum, statement_count: entry.statements.length, applied_at: null };
    };
    const matching = inventoryEntry("1", "review", [sql]);
    response.data = [matching];
    const matched = await invoke();
    expect(matched.plan.migrations[0].status).toBe("ledger-match");
    expect(matched.plan.migrations[0].ledgerChecksum).toBe(matching.checksum);
    expect(matched.plan.migrations[0].rawSha256).not.toBe(matching.checksum);
    for (const [data, status] of [
      [[inventoryEntry("1", "review", ["SELECT 'private-sql-value';"])], "checksum-mismatch"],
      [[inventoryEntry("1", "other", [sql])], "name-conflict"],
      [[inventoryEntry("3", "review", [sql])], "name-conflict"],
      [[inventoryEntry("3", "unrelated", ["SELECT 1;"])], "out-of-order"],
      [[inventoryEntry("1", "review", ["baseline:review"])], "checksum-mismatch"],
    ] as const) {
      response.data = data;
      const conflict = await invoke();
      expect(conflict.result.isError).toBe(true);
      expect(conflict.plan.ledgerCompatible).toBe(false);
      expect(conflict.plan.migrations[0].status).toBe(status);
    }
    for (const data of [[{ ...matching, checksum: "0".repeat(64) }], [matching, matching], { rows: [matching] }]) {
      response.data = data;
      const invalid = await invoke();
      expect(invalid.result.isError).toBe(true);
      expect(invalid.plan.error.code).toBe("INVALID_RESPONSE");
    }
    response = { ok: false, status: 503, data: { message: "private-sql-value" } };
    expect((await invoke()).plan.error).toEqual({ code: "HTTP_ERROR", http_status: 503 });
    response = { ok: false, status: 404, data: {} };
    expect((await invoke()).plan.error.code).toBe("HTTP_ERROR");
    response = { ok: true, status: 200, data: [] };
    responseRef = "wrong-project";
    expect((await invoke()).plan.error.code).toBe("INVALID_RESPONSE");
    responseRef = "test-project";
    readOnly = false;
    expect((await invoke()).plan.error.code).toBe("INVALID_RESPONSE");
    expect(requests.every(path => path === "/v1/projects/test-project/database/migrations/inventory")).toBe(true);
    const requestCount = requests.length;
    expect((await execute({ ...args, sql: "SELECT 1;" })).isError).toBe(true);
    expect((await execute({ ...args, ref: "../outside" })).isError).toBe(true);
    const object = built.manifest.objects.find(item => item.name === "api")!;
    await writeFile(join(root, "generated/delivery/objects", object.objectId, "bundle/index.js"), "tampered");
    expect((await invoke()).plan.error.code).toBe("INVALID_ARTIFACT");
    expect(requests).toHaveLength(requestCount);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
(bin ? test : test.skip)("delivery plan matches the native canonical ledger across restart and detects SQL drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-ledger-native-"));
  const database = await startStarterPostgres(bin!);
  try {
    const { sql, manifest } = await archiveFixture(root);
    const ledger = { unsafe: (query: string) => database.transaction(tx => tx.query(query)) };
    expect(await readMigrationInventory(ledger)).toEqual([]);
    const absent = await database.transaction(tx => tx.query(
      "SELECT to_regclass('supabase_migrations.schema_migrations')::text AS relation",
    ));
    assert.ok(Array.isArray(absent));
    expect(absent[0]?.relation).toBeNull();
    await ensureMigrationLedgerMetadata(ledger);
    const entry = createMigrationLedgerEntry({ version: "1", name: "review", statements: [sql] });
    await database.transaction(async tx => {
      await tx.query(sql);
      await tx.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,checksum)
        VALUES($1,$2,ARRAY[$3]::text[],$4)`, [entry.version, entry.name!, sql, entry.checksum]);
    });
    type Result = { isError?: boolean; content: Array<{ text: string }> };
    let execute!: (args: Record<string, unknown>) => Promise<Result>;
    let reads = 0;
    registerDatabaseTools({ tool(_name, _description, _schema, callback) { execute = callback; } }, {
      get: async (path: string) => {
        expect(path).toBe("/v1/projects/native-test/database/migrations/inventory");
        reads++;
        return { ok: true, status: 200, data: {
          project_ref: "native-test", read_only: true, migrations: await readMigrationInventory(ledger),
        } };
      },
      post: async () => { throw new Error("Unexpected write from planner"); },
    } as unknown as HttpTransport, { projectRef: "native-test", readOnly: true });
    const args = { action: "delivery_migration_plan", delivery_manifest: manifest, delivery_target: "api" };
    for (const phase of ["before-restart", "after-restart"] as const) {
      if (phase === "after-restart") await database.restart();
      const before = await readMigrationLedger(ledger);
      const result = await execute(args);
      expect(result.isError).toBeUndefined();
      const plan = JSON.parse(result.content[0]!.text);
      expect(plan.migrations[0].status).toBe("ledger-match");
      expect(plan.executionPerformed).toBe(false);
      expect(await readMigrationLedger(ledger)).toEqual(before);
      const roles = await database.transaction(tx => tx.query(
        "SELECT count(*)::integer AS count FROM pg_roles WHERE rolname='delivery_operator'",
      ));
      assert.ok(Array.isArray(roles));
      expect(roles[0]?.count).toBe(0);
    }
    const changed = createMigrationLedgerEntry({ version: "1", name: "review", statements: ["SELECT 1;"] });
    await database.transaction(tx => tx.query(
      "UPDATE supabase_migrations.schema_migrations SET statements=ARRAY[$1]::text[],checksum=$2 WHERE version='1'",
      [changed.statements[0]!, changed.checksum],
    ));
    const mismatch = await execute(args);
    expect(mismatch.isError).toBe(true);
    expect(JSON.parse(mismatch.content[0]!.text).migrations[0].status).toBe("checksum-mismatch");
    expect(reads).toBe(3);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
