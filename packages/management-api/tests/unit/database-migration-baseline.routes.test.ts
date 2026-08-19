// @supacloud-test-isolate — mocks project database sessions and migration leases.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

interface QueryCall {
  text: string;
  values: unknown[];
}

const transactionCalls: QueryCall[] = [];
let existingMigrationRows: Array<Record<string, unknown>> = [];
let transactionFailure: Error | null = null;

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
    return Promise.resolve([]);
  }),
  {
    array: (values: unknown[]) => values,
    unsafe: mock(async () => []),
  },
);
const connection = {
  begin: mock(async (operation: (sql: typeof transaction) => Promise<unknown>) => operation(transaction)),
  unsafe: mock(async () => []),
  release: mock(() => undefined),
};
const roleDb = { reserve: mock(async () => connection) };
const adminDb = Object.assign(mock(async () => []), { unsafe: mock(async () => []) });
const managementDb = mock((strings: TemplateStringsArray) => {
  if (strings.join("?").includes("SELECT db_name, db_user, db_password")) {
    return Promise.resolve([{
      db_name: "tenant_db",
      db_user: "tenant_user",
      db_password: "test-password",
    }]);
  }
  return Promise.resolve([]);
});

const getProject = mock(async () => ({ ref: "proj_1" }));
const requireProjectOrAdminAuth = mock(async () => undefined);
const issueMigrationLedgerLease = mock(async (_database: unknown, version: string) => ({
  token: `token-${version}`,
  tokenHash: `token-hash-${version}`,
}));
const releaseMigrationLedgerLease = mock(async () => undefined);
const prepareProjectMigrationRole = mock(async () => undefined);
const withProjectMigrationLocks = mock(async (_scope: unknown, operation: () => Promise<unknown>) => operation());
const assertInactive = mock(async () => undefined);

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
  ensureMigrationLedgerMetadata: mock(async () => undefined),
  reconcileMigrationLedgerVersions: mock(async () => undefined),
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

describe("database migration baseline route", () => {
  beforeEach(() => {
    resetEnsuredMigrationTablesForTests();
    transactionCalls.length = 0;
    existingMigrationRows = [];
    transactionFailure = null;
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
