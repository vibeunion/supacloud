// @supacloud-test-isolate — mocks project database sessions and migration leases.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { runtimeInput } from "../helpers/application-runtime";
import { stableSha256 } from "../../src/utils/stable-json";
import type { readMigrationInventory } from "../../src/services/migration-ledger";

interface QueryCall {
  text: string;
  values: unknown[];
}

const transactionCalls: QueryCall[] = [];
let existingMigrationRows: Array<Record<string, unknown>> = [];
let transactionFailure: Error | null = null;
let inventoryRows: Array<Record<string, unknown>> = [];
let legacyInventoryRows: Array<Record<string, unknown>> = [];
let inventoryFailure: Error | null = null;
let onLedgerInsert: ((values: unknown[]) => void) | undefined;

const transaction = Object.assign(
  mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    transactionCalls.push({ text, values });
    if (text.includes("FROM supabase_migrations.schema_migrations")) {
      return Promise.resolve(existingMigrationRows);
    }
    if (text.includes("record_schema_migration") && transactionFailure) {
      return Promise.reject(transactionFailure);
    }
    if (text.includes("record_schema_migration")) onLedgerInsert?.(values);
    return Promise.resolve([]);
  }),
  {
    array: (values: unknown[]) => values,
    unsafe: mock(async (_statement: string) => []),
  },
);
const connection = {
  begin: mock(async (operation: (sql: typeof transaction) => Promise<unknown>) => operation(transaction)),
  unsafe: mock(async (_statement: string) => []),
  release: mock(() => undefined),
};
const roleDb = { reserve: mock(async () => connection) };
const adminDb = Object.assign(mock(async () => []), { unsafe: mock(async (query: string) => {
  if (query.trimStart().startsWith("SELECT")) {
    if (inventoryFailure) throw inventoryFailure;
    return query.includes("FROM supabase_migrations.schema_migrations") ? inventoryRows : legacyInventoryRows;
  }
  return [];
}) });
const managementDb = mock((strings: TemplateStringsArray) => {
  if (strings.join("?").includes("SELECT db_name, db_user, db_password")
    || strings.join("?").includes("SELECT * FROM projects")) {
    return Promise.resolve([{
      db_name: "tenant_db",
      db_user: "tenant_user",
      db_password: "test-password",
    }]);
  }
  return Promise.resolve([]);
});

const getProject = mock(async () => ({ ref: "proj_1" }));
const requireProjectOrAdminAuth = mock(async (): Promise<undefined | { status: number; body: { error: string } }> => undefined);
const issueMigrationLedgerLease = mock(async (_database: unknown, version: string) => ({
  token: `token-${version}`,
  tokenHash: `token-hash-${version}`,
}));
const releaseMigrationLedgerLease = mock(async () => undefined);
const prepareProjectMigrationRole = mock(async () => undefined);
const withProjectMigrationLocks = mock(async (_scope: unknown, operation: () => Promise<unknown>) => operation());
const assertInactive = mock(async () => undefined);
const ensureMigrationLedgerMetadata = mock(async () => undefined);
const reconcileMigrationLedgerVersions = mock(async () => undefined);

const actualDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...actualDb,
  sql: managementDb,
  getProjectDb: mock(() => adminDb),
  getProjectRoleDb: mock(() => roleDb),
  removeProjectDbCache: mock(async () => undefined),
}));
mock.module("../../src/services", () => ({ projectService: { getProject } }));
mock.module("../../src/middleware/auth", () => ({
  requireAdminAuth: mock(async () => undefined),
  requireProjectOrAdminAuth,
}));

const actualLedger = await import("../../src/services/migration-ledger");
mock.module("../../src/services/migration-ledger", () => ({
  ...actualLedger,
  ensureMigrationLedgerMetadata,
  reconcileMigrationLedgerVersions,
}));
const actualLock = await import("../../src/services/migration-lock");
mock.module("../../src/services/migration-lock", () => ({
  ...actualLock,
  withProjectMigrationLocks,
}));
const actualJournal = await import("../../src/services/branch-replacement-journal");
mock.module("../../src/services/branch-replacement-journal", () => ({
  ...actualJournal,
  branchReplacementJournal: { assertInactive },
}));
mock.module("../../src/services/project-migration-role", () => ({ prepareProjectMigrationRole }));
mock.module("../../src/services/migration-ledger-lease", () => ({
  issueMigrationLedgerLease,
  releaseMigrationLedgerLease,
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { databaseRoutes, resetEnsuredMigrationTablesForTests } = await import(
  new URL("../../src/routes/database.ts?database-migration-baseline-routes-test", import.meta.url).href,
);
const app = new Elysia().use(databaseRoutes);

function baselineRequest(migrations: Array<{ version: string; name: string }>) {
  return app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/baseline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ migrations }),
  }));
}

function migrationRequest(migration: { version: string; name: string; sql: string }) {
  return app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(migration),
  }));
}

function expectNoLedgerWrites() {
  expect(ensureMigrationLedgerMetadata).not.toHaveBeenCalled();
  expect(reconcileMigrationLedgerVersions).not.toHaveBeenCalled();
  expect(prepareProjectMigrationRole).not.toHaveBeenCalled();
  expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
  expect(connection.begin).not.toHaveBeenCalled();
}

describe("database migration baseline route", () => {
  beforeEach(() => {
    resetEnsuredMigrationTablesForTests();
    transactionCalls.length = 0;
    existingMigrationRows = [];
    transactionFailure = null;
    inventoryRows = [];
    legacyInventoryRows = [];
    inventoryFailure = null;
    onLedgerInsert = undefined;
    adminDb.unsafe.mockClear();
    transaction.mockClear();
    transaction.unsafe.mockClear();
    connection.begin.mockClear();
    connection.unsafe.mockClear();
    connection.release.mockClear();
    managementDb.mockClear();
    getProject.mockClear();
    requireProjectOrAdminAuth.mockClear();
    issueMigrationLedgerLease.mockClear();
    releaseMigrationLedgerLease.mockClear();
    prepareProjectMigrationRole.mockClear();
    withProjectMigrationLocks.mockClear();
    assertInactive.mockClear();
    ensureMigrationLedgerMetadata.mockClear();
    reconcileMigrationLedgerVersions.mockClear();
  });

  test("read-only inventory returns a bound empty result using SELECT only", async () => {
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/inventory"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project_ref: "proj_1", read_only: true, migrations: [] });
    expect(adminDb.unsafe.mock.calls).toHaveLength(2);
    expect(adminDb.unsafe.mock.calls.every(([query]) => query.trimStart().startsWith("SELECT"))).toBe(true);
    expectNoLedgerWrites();
  });

  test("read-only inventory never creates missing ledger tables", async () => {
    inventoryFailure = Object.assign(new Error("relation missing"), { code: "42P01" });
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/inventory"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project_ref: "proj_1", read_only: true, migrations: [] });
    expect(adminDb.unsafe.mock.calls.every(([query]) => query.trimStart().startsWith("SELECT"))).toBe(true);
    expectNoLedgerWrites();
  });

  test("read-only inventory rejects stored checksum drift without repair or SQL disclosure", async () => {
    inventoryRows = [{ version: "1", name: "review", statements: ["SELECT 'private-inventory-value';"], checksum: "0".repeat(64) }];
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/inventory"));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("migration_ledger_diverged");
    expect(text).not.toContain("private-inventory-value");
    expect(adminDb.unsafe.mock.calls.every(([query]) => query.trimStart().startsWith("SELECT"))).toBe(true);
    expectNoLedgerWrites();
  });

  test("read-only inventory authorizes before reading the project database", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({ status: 403, body: { error: "forbidden" } });
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/inventory"));
    expect(response.status).toBe(403);
    expect(getProject).not.toHaveBeenCalled();
    expect(adminDb.unsafe).not.toHaveBeenCalled();
    expectNoLedgerWrites();
  });

  test("read-only inventory rejects canonical/legacy divergence without reconciliation", async () => {
    inventoryRows = [{ version: "1", name: "review", statements: ["SELECT 1;"] }];
    legacyInventoryRows = [{ version: "2", name: "other", statements: ["SELECT 2;"] }];
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/database/migrations/inventory"));
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe("migration_ledger_diverged");
    expect(adminDb.unsafe.mock.calls.every(([query]) => query.trimStart().startsWith("SELECT"))).toBe(true);
    expectNoLedgerWrites();
  });

  test("records baseline markers atomically without executing migration SQL", async () => {
    const migrations = [
      { version: "20260729090000", name: "20260729090000_create_orders" },
      { version: "20260729090100", name: "20260729090100_create_reports" },
    ];

    const response = await baselineRequest(migrations);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.marked).toBe(2);
    expect(body.already_applied).toBe(0);
    expect(connection.begin).toHaveBeenCalledTimes(1);
    expect(connection.unsafe.mock.calls).toEqual([["RESET ALL; DISCARD TEMP; DISCARD PLANS"]]);
    const recordCalls = transactionCalls.filter(({ text }) => text.includes("record_schema_migration"));
    expect(recordCalls).toHaveLength(2);
    expect(recordCalls[0]?.values[1]).toEqual(["baseline:20260729090000_create_orders"]);
    expect(issueMigrationLedgerLease).toHaveBeenCalledTimes(2);
    expect(releaseMigrationLedgerLease).toHaveBeenCalledTimes(2);
  });

  test("records schema reload notification in the migration transaction", async () => {
    const response = await migrationRequest({
      version: "20260819090000",
      name: "20260819090000_create_items",
      sql: "CREATE TABLE public.items(id bigint)",
    });

    expect(response.status).toBe(200);
    expect(transactionCalls.some(({ text }) => text.includes("record_schema_migration"))).toBe(true);
    expect(transactionCalls.some(({ text, values }) =>
      text.includes("pg_notify") && values.includes("pgrst_proj_1")
    )).toBe(true);
    expect(transaction.mock.invocationCallOrder.at(-1)).toBeGreaterThan(transaction.mock.invocationCallOrder[0]!);
  });

  test("application migration composition uses the shared default role transaction and real receipt checksum", async () => {
    const { ApplicationMigrations } = await import("../../src/services/application-migrations");
    const record = runtimeInput().release;
    const statement = "BEGIN; CREATE TABLE public.default_adapter_probe(id integer); COMMIT;\r\n";
    const rows: Awaited<ReturnType<typeof readMigrationInventory>> = [];
    const backupId = `logical-full_demo_${"a".repeat(32)}`;
    const stamp = new Date().toISOString();
    const backup = {
      backup_id: backupId, project_ref: "demo", database: "tenant_db", kind: "logical-full" as const,
      created_at: stamp, completed_at: stamp, bytes: 100, sha256: "e".repeat(64),
    };
    onLedgerInsert = values => {
      expect(values[0]).toBe("1");
      expect(values[1]).toEqual([statement]);
      expect(values[2]).toBe("default_adapter_probe");
      expect(typeof values[3]).toBe("string");
      rows.push({
        version: "1", name: "default_adapter_probe", statements: [statement], statement_count: 1,
        checksum: String(values[3]), applied_at: null,
      });
    };
    const service = new ApplicationMigrations({
      storage: { readMigrations: async () => ({
        record, archives: [{
          target: "api", objectId: record.targets[0]!.object_id, artifactVerified: true,
          migrations: [{
            version: "1", name: "default_adapter_probe", sql: statement,
            path: "migrations/project-migration/1_default_adapter_probe.sql",
            executor: "project-migration", bytes: Buffer.byteLength(statement),
            sha256: createHash("sha256").update(statement).digest("hex"),
          }],
        }],
      }) },
      inventory: async () => structuredClone(rows),
      backups: { create: async () => backup, read: async () => backup },
    });
    const result = await service.apply({
      projectRef: "demo", applicationId: "reviews", releaseId: record.release_id,
      expectedLedgerDigest: stableSha256([]), backupId,
    });
    expect(result.after.project_migrations_applied).toBe(true);
    expect(result.applied[0]?.strippedTransactionWrappers).toBe(2);
    expect(transaction.unsafe.mock.calls).toEqual([["CREATE TABLE public.default_adapter_probe(id integer)"]]);
    expect(prepareProjectMigrationRole).toHaveBeenCalledTimes(1);
    expect(issueMigrationLedgerLease).toHaveBeenCalledTimes(1);
    expect(releaseMigrationLedgerLease).toHaveBeenCalledTimes(1);
    expect(connection.begin).toHaveBeenCalledTimes(1);
    expect(transactionCalls.some(({ text }) => text.includes("pg_notify"))).toBe(true);
    expect(connection.unsafe.mock.calls).toEqual([["RESET ALL; DISCARD TEMP; DISCARD PLANS"]]);
  });

  test("rejects ABORT transaction control before executing or recording a migration", async () => {
    const response = await migrationRequest({
      version: "20260819090001",
      name: "20260819090001_abort_transaction",
      sql: "CREATE TABLE public.abort_probe(id bigint); ABORT AND CHAIN; SELECT 1",
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.code).toBe("unsupported_migration_sql");
    expect(transaction.unsafe).not.toHaveBeenCalled();
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
    expect(transactionCalls.some(({ text }) => text.includes("record_schema_migration"))).toBe(false);
  });

  test("retries schema reload for an already-applied migration", async () => {
    existingMigrationRows = [{
      version: "20260819090000",
      name: "20260819090000_create_items",
      statements: ["CREATE TABLE public.items(id bigint)"],
    }];

    const response = await migrationRequest({
      version: "20260819090000",
      name: "20260819090000_create_items",
      sql: "CREATE TABLE public.items(id bigint)",
    });
    const body = await response.json() as Record<string, unknown>;

    expect({ status: response.status, body }).toMatchObject({
      status: 409,
      body: { message: "Migration already applied", code: "409" },
    });
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
    expect(transactionCalls.some(({ text }) => text.includes("pg_notify"))).toBe(true);
  });

  test("exact legacy ledger SQL is observed before the current SQL policy without re-execution", async () => {
    const migration = {
      version: "20260819090000", name: "legacy_policy", sql: "ALTER ROLE postgres SUPERUSER;",
    };
    existingMigrationRows = [{
      ...migration, statements: [migration.sql], checksum: "legacy-raw-file-checksum",
    }];
    const response = await migrationRequest(migration);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: "Migration already applied", code: "409" });
    expect(transaction.unsafe).not.toHaveBeenCalled();
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
    expect(transactionCalls.some(({ text }) => text.includes("pg_notify"))).toBe(true);
  });

  test("a conflicting historical checksum is reported before the current SQL policy", async () => {
    existingMigrationRows = [{
      version: "20260819090000", name: "legacy_policy", statements: ["SELECT 1;"], checksum: "d".repeat(64),
    }];
    const response = await migrationRequest({
      version: "20260819090000", name: "legacy_policy", sql: "ALTER ROLE postgres SUPERUSER;",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "migration_checksum_conflict" });
    expect(transaction.unsafe).not.toHaveBeenCalled();
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
  });

  test("is idempotent for an identical baseline marker", async () => {
    existingMigrationRows = [{
      version: "20260729090000",
      name: "20260729090000_create_orders",
      statements: ["baseline:20260729090000_create_orders"],
    }];

    const response = await baselineRequest([{
      version: "20260729090000",
      name: "20260729090000_create_orders",
    }]);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.marked).toBe(0);
    expect(body.already_applied).toBe(1);
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
  });

  test("rejects ledger conflicts instead of overwriting history", async () => {
    existingMigrationRows = [{
      version: "20260729090000",
      name: "20260729090000_create_orders",
      statements: ["CREATE TABLE orders (id uuid)"],
    }];

    const response = await baselineRequest([{
      version: "20260729090000",
      name: "20260729090000_create_orders",
    }]);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.code).toBe("migration_baseline_conflict");
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
  });

  test("rejects a mixed exact match and conflicting migration identity", async () => {
    existingMigrationRows = [
      {
        version: "20260729090000",
        name: "20260729090000_create_orders",
        statements: ["baseline:20260729090000_create_orders"],
      },
      {
        version: "20260729090100",
        name: "20260729090000_create_orders",
        statements: ["baseline:20260729090000_create_orders"],
      },
    ];

    const response = await baselineRequest([{
      version: "20260729090000",
      name: "20260729090000_create_orders",
    }]);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.code).toBe("migration_baseline_conflict");
    expect(issueMigrationLedgerLease).not.toHaveBeenCalled();
  });

  test("releases the lease and redacts details when ledger insertion fails", async () => {
    transactionFailure = new Error("connection failed password=top-secret");

    const response = await baselineRequest([{
      version: "20260729090000",
      name: "20260729090000_create_orders",
    }]);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.detail).toBe("connection failed password=[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("top-secret");
    expect(releaseMigrationLedgerLease).toHaveBeenCalledTimes(1);
  });

  test("rejects duplicate normalized migration identities before opening a transaction", async () => {
    const response = await baselineRequest([
      { version: "0001", name: "first_name" },
      { version: "1", name: "second_name" },
    ]);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.code).toBe("duplicate_migration_baseline");
    expect(connection.begin).not.toHaveBeenCalled();
  });
});
