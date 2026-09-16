import { afterAll, beforeAll, expect, expectTypeOf, test } from "bun:test";
import { SQL as BunSQL } from "bun";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { boolean, integer, pgSchema, text } from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-orm/typebox-legacy";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as ts from "@typescript/typescript6";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineDrizzleDatabaseModule, executeDecodedSql } from "../src/drizzle";
import { createBunDrizzleCommandDatabase, createBunDrizzleReadDatabase } from "../src/drizzle-bun";
import { createPostgresCommandStore } from "../src/command-adapter";
import { COMMAND_PERSISTENCE_SQL } from "../src/command-schema";
import { createTypeBoxTransactionalCommand } from "../../commands/src/typebox";
import { plaintextCommandInput } from "../../commands/src/context";
import { createBunReadDatabase } from "../src/command-bun";
import { readSqlDependencyGraph } from "../src/sql-analysis";
import { scanDrizzleSql } from "../../compiler/src/sql-safety";
import { scanProductionSource } from "../../compiler/src/type-safety";

const records = pgSchema("app").table("settings", {
  id: text().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  enabled: boolean().notNull().default(false),
  version: integer().notNull().default(0),
});
const rowSchema = createSelectSchema(records);
const inputSchema = Type.Pick(rowSchema, ["id", "enabled"], { additionalProperties: false });
const resultSchema = Type.Pick(rowSchema, ["id", "enabled", "version"], { additionalProperties: false });
const actor = { tenantId: "tenant-a", actorId: "operator-a" };
const container = `supacloud-drizzle-${crypto.randomUUID()}`;
let pool: BunSQL;
let db: BunSQLDatabase;
let started = false;

function docker(args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeAll(async () => {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=supacloud_drizzle_test", "-p", "127.0.0.1::5432", "postgres:18.4-bookworm"]);
  started = true;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Invalid local PostgreSQL port");
  pool = new BunSQL(`postgres://postgres@127.0.0.1:${port}/supacloud_drizzle_test`);
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await pool`SELECT 1`; ready = true; break; }
    catch { await Bun.sleep(250); }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not start");
  await pool.unsafe(COMMAND_PERSISTENCE_SQL);
  await pool.unsafe(`CREATE SCHEMA app;
    CREATE TABLE app.settings(id text PRIMARY KEY, tenant_id text NOT NULL,
      enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0)`);
  db = drizzle({ client: pool });
}, 30_000);

afterAll(async () => {
  try { await pool?.close(); }
  finally { if (started) docker(["rm", "-f", container]); }
});

function command(options: { auditFailure?: boolean; badResult?: boolean } = {}) {
  return createTypeBoxTransactionalCommand({
    store: createPostgresCommandStore(createBunDrizzleCommandDatabase(pool)),
    name: "settings.update", schemas: { input: inputSchema, result: resultSchema },
    inputCodec: plaintextCommandInput,
    authorize: async (identity, input, tx) => {
      const found = await tx.db.select({ id: records.id }).from(records)
        .where(and(eq(records.id, input.id), eq(records.tenantId, identity.tenantId)));
      return found.length === 1 ? "allow" : "deny";
    },
    execute: async (tx, input, identity) => {
      await Promise.resolve();
      const scoped = tx.db;
      expect(scoped).toBe(tx.db);
      expect(scoped).not.toBe(db);
      const rows = await scoped.update(records)
        .set({ enabled: input.enabled, version: sql`${records.version} + 1` })
        .where(and(eq(records.id, input.id), eq(records.tenantId, identity.tenantId)))
        .returning({ id: records.id, enabled: records.enabled, version: records.version });
      const row = rows[0];
      if (!row) throw new Error("Record unavailable");
      // Deliberate runtime fault: the static shape is valid, but the schema rejects a float.
      return options.badResult ? { ...row, version: 1.5 } : row;
    },
    audit: {
      event: "settings.updated",
      details: (input, result) => ({ id: input.id, version: result.version }),
      write: async (tx, input, result) => {
        const visible = await tx.db.select().from(records).where(eq(records.id, input.id));
        expect(visible[0]?.version).toBe(result.version);
        if (options.auditFailure) throw new Error("Audit write failed");
      },
    },
  });
}

async function seed() {
  const id = crypto.randomUUID();
  await db.insert(records).values({ id, tenantId: actor.tenantId });
  return id;
}

test("real Drizzle table metadata and derived schemas need no duplicate row interfaces", () => {
  expect(Reflect.get(records, "_")).toBeUndefined();
  expect(defineDrizzleDatabaseModule({ records, alias: records }, { name: "settings" }).tables)
    .toEqual(["app.settings"]);
  expectTypeOf<Static<typeof rowSchema>>().toEqualTypeOf<typeof records.$inferSelect>();
  expect(Value.Check(inputSchema, { id: "id", enabled: true })).toBe(true);
  expect(Value.Check(inputSchema, { id: "id", enabled: true, tenantId: "spoof" })).toBe(false);
});

test("Drizzle business writes and SQL receipts/audit commit once through explicit transaction dependencies", async () => {
  const id = await seed(), operation = crypto.randomUUID(), useCase = command();
  const first = await useCase.execute(actor, operation, { id, enabled: true });
  expect(first).toMatchObject({ status: "confirmed", result: { id, enabled: true, version: 1 } });
  expect(await useCase.executeUnknown(actor, operation, { id, enabled: true })).toEqual(first);
  const rows = await db.select().from(records).where(eq(records.id, id));
  expect(rows[0]?.version).toBe(1);
  const audit: unknown = await pool`SELECT count(*)::int AS count FROM supacloud_commands.execution_audit
    WHERE operation_key=${operation}`;
  expect(Value.Check(Type.Array(Type.Object({ count: Type.Integer() })), audit)).toBe(true);
  if (!Array.isArray(audit)) throw new Error("Expected audit rows");
  expect(audit[0]).toEqual({ count: 1 });
});

test("read query boundary enforces PostgreSQL READ ONLY even through a mutating function", async () => {
  const id = await seed();
  const reads = createBunReadDatabase(pool, 50);
  expect(await reads.query("SELECT id FROM app.settings WHERE id=$1", [id])).toEqual([{ id }]);
  await pool.unsafe(`CREATE FUNCTION app.forbidden_read() RETURNS integer LANGUAGE plpgsql AS $$
    BEGIN UPDATE app.settings SET enabled=true; RETURN 1; END $$`);
  await expect(reads.query("SELECT app.forbidden_read()")).rejects.toThrow();
  expect((await db.select().from(records).where(eq(records.id, id)))[0]?.enabled).toBe(false);
  await expect(reads.query("COMMIT; UPDATE app.settings SET enabled=true")).rejects.toThrow();
  await expect(reads.query("SELECT pg_sleep(1)")).rejects.toThrow();
  const abort = new AbortController();
  const pending = reads.query("SELECT pg_sleep(1)", [], abort.signal);
  const rejected = pending.then(() => undefined, (error: unknown) => error);
  abort.abort();
  expect(await rejected).toBeInstanceOf(Error);
  // Failed/cancelled reads must return the pool connection without leaking READ ONLY.
  await db.update(records).set({ enabled: true }).where(eq(records.id, id));
  expect((await db.select().from(records).where(eq(records.id, id)))[0]?.enabled).toBe(true);
  const drizzleReads = createBunDrizzleReadDatabase(pool);
  expect(await drizzleReads.read((db) => db.select({ id: records.id }).from(records).where(eq(records.id, id)))).toEqual([{ id }]);
  await expect(drizzleReads.read((db) => db.update(records).set({ enabled: false }).where(eq(records.id, id)))).rejects.toThrow();
});

test("live catalog dependency snapshot discovers views and marks opaque functions", async () => {
  await pool.unsafe("CREATE VIEW app.settings_view AS SELECT id FROM app.settings");
  const graph = await readSqlDependencyGraph({
    query: async (text, parameters) => {
      const rows: unknown = await pool.unsafe<unknown>(text, parameters);
      return rows;
    },
  }, ["app", "schema'with\"quotes"]);
  expect(graph.edges).toContainEqual({ dependent: 'relation:"app"."settings_view"', dependency: 'relation:"app"."settings"' });
  expect(graph.review.some((message) => message.includes("forbidden_read"))).toBe(true);
});

test("invalid result and audit failure roll back real PostgreSQL writes and receipts", async () => {
  for (const options of [{ badResult: true }, { auditFailure: true }]) {
    const id = await seed(), operation = crypto.randomUUID();
    await expect(command(options).execute(actor, operation, { id, enabled: true }))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    const rows = await db.select().from(records).where(eq(records.id, id));
    expect(rows[0]).toMatchObject({ enabled: false, version: 0 });
    const receipts: unknown = await pool`SELECT count(*)::int AS count
      FROM supacloud_commands.execution_receipts WHERE operation_key=${operation}`;
    expect(Value.Check(Type.Array(Type.Object({ count: Type.Integer() })), receipts)).toBe(true);
    if (!Array.isArray(receipts)) throw new Error("Expected receipt rows");
    expect(receipts[0]).toEqual({ count: 0 });
  }
});

test("unknown inputs and cross-tenant requests cannot mutate the domain row", async () => {
  const id = await seed(), useCase = command();
  await expect(useCase.executeUnknown(actor, "invalid", { id, enabled: "yes" }))
    .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  await expect(useCase.execute({ ...actor, tenantId: "tenant-b" }, "denied", { id, enabled: true }))
    .rejects.toMatchObject({ code: "COMMAND_REJECTED" });
  expect((await db.select().from(records).where(eq(records.id, id)))[0]?.version).toBe(0);
});

test("parameterized raw SQL keeps values separate and requires a result decoder", async () => {
  const text = "'; DROP TABLE app.settings; --";
  const schema = Type.Array(Type.Object({ value: Type.String() }));
  const decoded = await executeDecodedSql(db, sql`SELECT ${text}::text AS value`, (value) => {
    if (!Value.Check(schema, value)) throw new Error("Invalid SQL rows");
    return value;
  });
  expectTypeOf(decoded).toEqualTypeOf<{ value: string }[]>();
  expect(decoded).toEqual([{ value: text }]);
  await expect(executeDecodedSql(db, sql`SELECT 1 AS value`, (value) => {
    if (!Value.Check(schema, value)) throw new Error("Invalid SQL rows");
    return value;
  })).rejects.toThrow("Invalid SQL rows");
});

test("compiler resolves Drizzle aliases without matching unrelated sql helpers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supacloud-sql-types-"));
  try {
    await symlink(resolve(import.meta.dir, "../node_modules"), join(dir, "node_modules"), "dir");
    await Bun.write(join(dir, "barrel.ts"), 'export { sql as query } from "drizzle-orm";');
    const path = join(dir, "source.ts");
    await Bun.write(path, `
import { query } from "./barrel";
import * as orm from "drizzle-orm";
const value = "parameter";
export const good = query\`SELECT \${value}\`;
export const asserted = query<{ secret: string }>\`SELECT 1\`;
export const namespaceAssertion = orm.sql<number>\`SELECT 1\`;
export const unknown = query<unknown>\`SELECT 1\`;
export const dynamic = query.raw(value);
export const staticDdl = query.raw("CREATE TABLE example(id integer)");
const unrelated = { raw: (value: string) => value };
unrelated.raw(value);
`);
    const program = ts.createProgram([path], {
      strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    const source = program.getSourceFile(path);
    if (!source) throw new Error("Missing compiler fixture");
    const diagnostics = scanDrizzleSql(source, program.getTypeChecker(), "source.ts", true);
    expect(diagnostics.map((diagnostic) => diagnostic.errorCode)).toEqual(["SC6007", "SC6007", "SC6008"]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    const productionDiagnostics = scanProductionSource({ rootDir: dir, strict: true });
    expect(productionDiagnostics.filter((diagnostic) =>
      diagnostic.errorCode === "SC6007" || diagnostic.errorCode === "SC6008")
      .map((diagnostic) => diagnostic.errorCode)).toEqual(["SC6007", "SC6007", "SC6008"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function negativeTypes() {
  const useCase = command();
  // @ts-expect-error Schema owns input types.
  useCase.execute(actor, "key", { id: "id", enabled: 1 });
  // @ts-expect-error Drizzle owns persisted column types.
  db.insert(records).values({ id: "id", tenantId: "tenant", enabled: "true" });
  // @ts-expect-error Raw SQL requires an explicit decoder.
  executeDecodedSql(db, sql`SELECT 1`);
}
void negativeTypes;
