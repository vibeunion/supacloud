import { afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "./typescript";
import { CompiledQuery } from "kysely";
import { BunPostgresDialect, type BunSqlPool } from "./bun-dialect";
import { compileModel, modelProcess } from "./model";
import { modelMain } from "./model-cli";
import { createZenStackDatabase } from "./zenstack";
import { schema } from "../tests/fixtures/model/generated/schema";
import { COMMAND_PERSISTENCE_SQL } from "./command-schema";
import { databaseSources } from "./source-contracts";
import { appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { generateDatabaseContracts, parseDatabaseContractsOptions } from "../../compiler/src/database-contracts";
import { registerRemoteDevTools } from "../../cli/src/shared/tools/remote-dev-tools";
import type { ToolInvocation } from "../../cli/src/shared/tool-server";
import { startStarterPostgres } from "../../../scripts/lib/starter-postgres";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "zenstack-upgrade-")); roots.push(root); return root; }
async function starter(root: string) {
  for (const [file, source] of Object.entries(appStarterFiles("model-upgrade"))) {
    await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), source);
  }
  await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
}
test("real model types, source boundaries and stale contracts fail closed", async () => {
  const root = await temporary(); await starter(root);
  const before = await readFile(join(root, "migrations/001-review.sql"), "utf8");
  const first = await databaseSources(root, "generate");
  expect(first.findings).toEqual([]); expect(first.ok).toBe(true);
  expect((await databaseSources(root)).ok).toBe(true);
  await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
  const consumer = join(root, "consumer.ts");
  await writeFile(consumer, 'import type { ReviewRow } from "./db/schema"; const row: ReviewRow = { id: "1", ownerId: "owner", state: "draft", version: 1 }; void row;');
  await using program = await ts.createProgram([consumer], { strict: true, skipLibCheck: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  expect((await ts.getPreEmitDiagnostics(program)).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  await writeFile(join(root, "src/escape.ts"), 'export { ZenStackClient as Client } from "@zenstackhq/orm";');
  expect((await databaseSources(root, "generate")).findings.some(f => f.code === "model-boundary")).toBe(true);
  await rm(join(root, "src/escape.ts"));
  const tsconfig: unknown = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  if (!tsconfig || typeof tsconfig !== "object" || !("compilerOptions" in tsconfig)
    || !tsconfig.compilerOptions || typeof tsconfig.compilerOptions !== "object") throw new Error("Invalid fixture tsconfig");
  Object.assign(tsconfig.compilerOptions, { paths: { "#host": ["./src/host/raw.ts"] } });
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(tsconfig));
  await writeFile(join(root, "src/host/raw.ts"), 'export { createZenStackDatabase } from "@supacloud/db/zenstack";');
  await writeFile(join(root, "src/escape.ts"), 'export { createZenStackDatabase } from "#host";');
  expect((await databaseSources(root, "generate")).findings.some(f => f.code === "model-boundary")).toBe(true);
  await rm(join(root, "src/escape.ts"));
  const modelFile = join(root, "zenstack/schema.zmodel");
  await writeFile(modelFile, (await readFile(modelFile, "utf8")).replace("  state String", "  state String\n  label String?"));
  await expect(compileModel(modelFile, join(root, "zenstack/generated"), true)).rejects.toThrow("stale");
  expect((await databaseSources(root, "generate")).ok).toBe(false);
  expect(await readFile(join(root, "migrations/001-review.sql"), "utf8")).toBe(before);
}, 30_000);
test("pinned candidate generator never applies or rewrites migration history", async () => {
  const root = await temporary(); await starter(root);
  const migration = await readFile(join(root, "migrations/001-review.sql"), "utf8");
  const candidate = join(root, "candidate.sql");
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", join(root, "zenstack/generated/schema.prisma"), "--script", "--output", candidate], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, out + err).toBe(0); expect(await readFile(candidate, "utf8")).toContain("starter_reviews");
  expect(await readFile(join(root, "migrations/001-review.sql"), "utf8")).toBe(migration);
  expect(modelProcess("diff", "schema.zmodel", "generated", "candidate.sql").args).not.toContain("deploy");
  await expect(modelMain(["migrate"])).rejects.toThrow("Usage");
  const files = appStarterFiles("model-upgrade");
  expect(files["package.json"]).toContain("supacloud-model diff");
  expect(Object.keys(files).join("\n") + files["package.json"]).not.toMatch(/drizzle|reylo/i);
}, 30_000);
test("native driver parameters, counts, savepoints and lifetime", async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = []; let releases = 0, closes = 0;
  const pool: BunSqlPool = { reserve: async () => ({ unsafe: async (sql, args) => { calls.push({ sql, args }); return Object.assign([], { count: 2, command: "UPDATE" }); }, release: () => { releases++; } }), close: async () => { closes++; } };
  const factory: unknown = createZenStackDatabase;
  if (typeof factory !== "function") throw new Error("Missing model factory");
  expect(() => Reflect.apply(factory, undefined, [schema, pool, { validateInput: false }])).toThrow("cannot be overridden");
  const dialect = new BunPostgresDialect(pool);
  const driver = dialect.createDriver(); const connection = await driver.acquireConnection();
  await driver.beginTransaction(connection, { isolationLevel: "serializable", accessMode: "read write" });
  expect((await connection.executeQuery(CompiledQuery.raw("update note set value=$1", [2]))).numAffectedRows).toBe(2n);
  if (!driver.savepoint) throw new Error("Missing native savepoint support");
  const compiler = dialect.createQueryCompiler();
  await driver.savepoint(connection, 'a"b', compiler.compileQuery.bind(compiler));
  await driver.rollbackTransaction(connection);
  await driver.releaseConnection(connection); await driver.releaseConnection(connection);
  await expect(connection.executeQuery(CompiledQuery.raw("SELECT 1"))).rejects.toThrow("released");
  await driver.destroy(); expect(releases).toBe(1); expect(closes).toBe(0);
  expect(calls.map(c => c.sql)).toEqual(["BEGIN ISOLATION LEVEL serializable read write", "update note set value=$1", 'SAVEPOINT "a""b"', "ROLLBACK"]);
  expect(calls[1]?.args).toEqual([2]);
});
const postgresBin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
test.skipIf(!postgresBin)("real Bun SQL policy, receipt and audit atomicity; capabilities expire", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    // Actual persistence table definitions; PGMQ dispatch is outside this adapter regression.
    await server.exec(COMMAND_PERSISTENCE_SQL.slice(COMMAND_PERSISTENCE_SQL.indexOf("CREATE SCHEMA"), COMMAND_PERSISTENCE_SQL.indexOf("CREATE OR REPLACE FUNCTION")));
    await server.withConnection(async url => {
      const root = await temporary();
      await mkdir(join(root, "zenstack"));
      const modelFile = join(root, "zenstack/schema.zmodel");
      await writeFile(modelFile, await readFile(resolve(import.meta.dir, "../tests/fixtures/model/schema.zmodel"), "utf8"));
      await compileModel(modelFile, join(root, "zenstack/generated"));
      await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
      for (const [command, candidate] of [["diff", "candidate.sql"], ["pull", "candidate.zmodel"]]) {
        const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "model-cli.ts"), command!, "--candidate", candidate!], {
          cwd: root, env: { ...process.env, SUPACLOUD_MODEL_DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
        });
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, (out + err).replaceAll(url, "[local database]").replaceAll(new URL(url).password, "[redacted]")).toBe(0);
        expect(await readFile(join(root, candidate!), "utf8")).toBeString();
      }
      expect(await readFile(modelFile, "utf8")).toContain('@@allow("all"');
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const identity = { id: "alice" }; const alice = db.forIdentity(identity); identity.id = "mallory";
        const bob = db.forIdentity({ id: "bob" });
        const ref = { tenantId: "tenant", actorId: "alice", command: "note.create", operationId: "first" };
        const record = { receipt: { ...ref, dispatchKey: crypto.randomUUID(), status: "confirmed" as const, audit: "complete" as const, result: { ok: true } }, kind: "transactional" as const, inputFingerprint: "0".repeat(64), inputPayload: null };
        let escaped: (() => Promise<unknown>) | undefined;
        await expect(alice.commandStore.transaction(async session => {
          expect(Reflect.has(session.transaction, "query")).toBe(false);
          await session.transaction.db.note.create({ data: { id: "rollback", owner: "alice", value: 1 } });
          await session.insert(record); await session.audit(ref, "created", {});
          escaped = () => session.transaction.db.note.findMany(); throw new Error("rollback");
        })).rejects.toThrow();
        expect(await alice.models.note.findMany()).toEqual([]);
        expect(await pool`SELECT * FROM supacloud_commands.execution_receipts`).toHaveLength(0);
        expect(await pool`SELECT * FROM supacloud_commands.execution_audit`).toHaveLength(0);
        expect(escaped).toBeDefined(); await expect(escaped!()).rejects.toThrow("closed");
        await alice.commandStore.transaction(async session => {
          await session.transaction.db.note.create({ data: { id: "committed", owner: "alice", value: 2 } });
          await session.insert(record); await session.audit(ref, "created", {});
        });
        expect(await alice.models.note.findMany()).toHaveLength(1); expect(await bob.models.note.findMany()).toHaveLength(0);
        expect(await pool`SELECT * FROM supacloud_commands.execution_receipts`).toHaveLength(1);
        expect(await pool`SELECT * FROM supacloud_commands.execution_audit`).toHaveLength(1);
        await expect(bob.commandStore.transaction(s => s.transaction.db.note.create({ data: { id: "denied", owner: "alice", value: 3 } }))).rejects.toThrow();
        for (const key of ["$queryRawUnsafe", "$setAuth", "$unuse", "$transaction", "$qb"]) expect(Reflect.has(alice.models, key)).toBe(false);
        expect(Reflect.has(alice.models.note, "create")).toBe(false); expect(Reflect.has(alice.models.note, "client")).toBe(false);
        await db.dispose(); await expect(alice.models.note.findMany()).rejects.toThrow("disposed");
        expect(await pool`SELECT 1`).toHaveLength(1);
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test("compiler exposes actual model schema types and rejects the removed option", async () => {
  const root = await temporary();
  await writeFile(join(root, "schema.ts"), await readFile(resolve(import.meta.dir, "../tests/fixtures/model/generated/schema.ts"), "utf8"));
  await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
  const options = parseDatabaseContractsOptions({ rootDir: ".", outDir: "generated", modelSchema: "schema.ts", role: "authenticated", migrations: [] }, root);
  expect(() => parseDatabaseContractsOptions({ drizzleSchema: "schema.ts" }, root)).toThrow();
  await generateDatabaseContracts(options);
  const consumer = join(root, "consumer.ts");
  await writeFile(consumer, `import type { ModelSchema } from "./generated/database";
import type { ModelResult } from "@zenstackhq/orm";
import { SQL } from "bun";
import { createZenStackDatabase } from "${resolve(import.meta.dir, "zenstack").replaceAll("\\", "/")}";
import { schema } from "./schema";
const host = createZenStackDatabase(schema, new SQL("postgres://unused"), {});
const row: ModelResult<ModelSchema["schema"], "Note"> = { id: "1", owner: "alice", value: 1, steps: [] };
void [host, row];`);
  await using program = await ts.createProgram([consumer], { strict: true, skipLibCheck: true, noEmit: true,
    types: ["bun"], typeRoots: [join(root, "node_modules/@types")], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  expect((await ts.getPreEmitDiagnostics(program)).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
});

test("removed dev migration action and config fail before remote execution", async () => {
  const root = await temporary();
  let invoke: ToolInvocation | undefined;
  let calls = 0;
  registerRemoteDevTools({ tool(_name, _description, _schema, handler) { invoke = handler; } }, {
    cwd: root, environment: "test", execute: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  if (!invoke) throw new Error("Missing dev tool");
  await expect(invoke({ action: "migrate" })).rejects.toThrow();
  await writeFile(join(root, "supacloud.json"), JSON.stringify({ dev: { database: {} } }));
  await expect(invoke({ action: "status" })).rejects.toThrow("dev.database was removed");
  expect(calls).toBe(0);
});

test.skipIf(!postgresBin)("model command lock serializes writers, is transaction-scoped and deadlock-free", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.exec(COMMAND_PERSISTENCE_SQL.slice(COMMAND_PERSISTENCE_SQL.indexOf("CREATE SCHEMA"), COMMAND_PERSISTENCE_SQL.indexOf("CREATE OR REPLACE FUNCTION")));
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        // 占位锁必须在事务结束后释放：第二个事务拿到锁时第一个已经提交。
        let committed = false;
        const holder = alice.commandStore.transaction(async session => {
          await session.transaction.lock(["inventory:lot-1"]);
          await Bun.sleep(150);
          committed = true;
        });
        await Bun.sleep(40);
        const follower = alice.commandStore.transaction(async session => {
          await session.transaction.lock(["inventory:lot-1"]);
          // 拿到锁的那一刻，持有者必然已经提交，证明锁是事务作用域而不是连接泄漏。
          expect(committed).toBe(true);
          await session.transaction.db.note.create({ data: { id: "after-lock", owner: "alice", value: 1 } });
        });
        await Promise.all([holder, follower]);
        expect(await alice.models.note.count()).toBe(1);
        // 同一组键的顺序不影响获取：并发两端不会互相死锁。
        const ordered = await Promise.all([
          alice.commandStore.transaction(async s => { await s.transaction.lock(["b", "a", "c"]); await Bun.sleep(60); }),
          alice.commandStore.transaction(async s => { await s.transaction.lock(["c", "a", "b"]); await Bun.sleep(60); }),
        ]);
        expect(ordered).toHaveLength(2);
        // 回滚同样释放锁，不残留到下一个命令。
        await expect(alice.commandStore.transaction(async s => {
          await s.transaction.lock(["inventory:lot-2"]); throw new Error("rollback");
        })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
        await alice.commandStore.transaction(async s => {
          await s.transaction.lock(["inventory:lot-2"]); await s.transaction.db.note.create({ data: { id: "after-rollback", owner: "alice", value: 2 } });
        });
        expect(await alice.models.note.count()).toBe(2);
        // 键集合错误必须在发 SQL 前失败，不能退化成共享哈希。
        for (const keys of [[], ["  "], Array.from({ length: 17 }, (_, i) => `k${i}`), ["x".repeat(201)]]) {
          await expect(alice.commandStore.transaction(s => s.transaction.lock(keys)))
            .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        }
        // 命令事务只暴露 db + lock，原始 SQL 仍然不可达。
        await alice.commandStore.transaction(async session => {
          expect(Reflect.has(session.transaction, "query")).toBe(false);
          expect(Reflect.has(session.transaction, "lock")).toBe(true);
        });
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test.skipIf(!postgresBin)("readFunction bridges STABLE SQL definitions and rejects write-capable ones", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.exec(COMMAND_PERSISTENCE_SQL.slice(COMMAND_PERSISTENCE_SQL.indexOf("CREATE SCHEMA"), COMMAND_PERSISTENCE_SQL.indexOf("CREATE OR REPLACE FUNCTION")));
    await server.exec(`
      CREATE SCHEMA helpers;
      CREATE TYPE helpers.role AS ENUM ('reader', 'writer');
      CREATE FUNCTION helpers.note_count() RETURNS bigint LANGUAGE sql STABLE AS 'SELECT count(*) FROM public."Note"';
      CREATE FUNCTION helpers.note_label(text) RETURNS text LANGUAGE sql STABLE AS 'SELECT $1 || ''-ok''';
      CREATE FUNCTION helpers.has_role(helpers.role[]) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT ''writer''::helpers.role = ANY($1)';
      CREATE FUNCTION helpers.note_values() RETURNS SETOF integer LANGUAGE sql STABLE AS 'SELECT value FROM public."Note"';
      CREATE FUNCTION helpers.sneaky_touch() RETURNS integer LANGUAGE plpgsql VOLATILE AS
        'BEGIN INSERT INTO public."Note" VALUES (''sneaky'',''alice'',0); RETURN 1; END';
      CREATE AGGREGATE helpers.total(integer) (sfunc = int4pl, stype = integer);
    `);
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        // 同事务可见性：命令里刚写的行，SQL 函数必须看得见；回滚后一起消失。
        await expect(alice.commandStore.transaction(async session => {
          expect(await session.transaction.readFunction("helpers.note_count")).toBe(0);
          await session.transaction.db.note.create({ data: { id: "in-tx", owner: "alice", value: 1 } });
          expect(Number(await session.transaction.readFunction("helpers.note_count"))).toBe(1);
          throw new Error("rollback");
        })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
        expect(await alice.models.note.count()).toBe(0);
        await alice.commandStore.transaction(async session => {
          expect(await session.transaction.readFunction("helpers.note_label", ["abc"])).toBe("abc-ok");
          expect(await session.transaction.readFunction("helpers.has_role", [["reader", "writer"]])).toBe(true);
          await session.transaction.db.note.create({ data: { id: "committed", owner: "alice", value: 2 } });
          expect(Number(await session.transaction.readFunction("helpers.note_count"))).toBe(1);
        });
        // 写能力的三类形态都被拒：VOLATILE、聚合、不可解析的名字。
        for (const name of ["helpers.sneaky_touch"]) {
          await expect(alice.commandStore.transaction(s => s.transaction.readFunction(name)))
            .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        }
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.total", [1])))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.note_values")))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        for (const name of ["helpers.missing", "note_count", "helpers.note_count; DROP TABLE \"Note\"", "helpers.\"note_count\"", "pg_catalog.now"]) {
          await expect(alice.commandStore.transaction(s => s.transaction.readFunction(name)))
            .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        }
        // 重载按参数个数解析；没有唯一匹配就失败，不猜。
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.note_label")))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.note_label", [{ nested: true } as never])))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.has_role", [["reader", ["writer"]] as never])))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        await expect(alice.commandStore.transaction(s => s.transaction.readFunction("helpers.has_role", ["writer"])))
          .rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
        // 事务里仍然拿不到 query，也拿不到新的原始入口。
        await alice.commandStore.transaction(async session => {
          expect(Reflect.has(session.transaction, "query")).toBe(false);
          expect(Reflect.has(session.transaction, "readFunction")).toBe(true);
        });
        expect(await alice.models.note.count()).toBe(1);
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test.skipIf(!postgresBin)("model updates preserve top-level Json arrays as one jsonb value", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        const steps = [{ code: "S1", detail: { approved: true } }] as never;
        // Seed rows outside the model create path so this case exercises the
        // ORM transformInput path without depending on policy pre-create values.
        await pool.unsafe("INSERT INTO \"Note\" (id, owner, value, steps) VALUES ($1, $2, $3, $4::jsonb), ($5, $2, $6, $4::jsonb)", [
          "json-one", "alice", 1, JSON.stringify({ code: "seed" }), "json-many", 2,
        ]);
        await alice.commandStore.transaction(async session => {
          await session.transaction.db.note.update({ where: { id: "json-one" }, data: { steps } });
          await session.transaction.db.note.updateMany({ where: { id: "json-many" }, data: { steps } });
        });
        const rows = await pool`SELECT id, jsonb_typeof(steps) AS kind, steps FROM "Note" ORDER BY id`;
        expect(rows.map((row: { id: string; kind: string }) => [row.id, row.kind])).toEqual([
          ["json-many", "array"], ["json-one", "array"],
        ]);
        expect(rows[0].steps).toEqual(steps);
        expect(rows[1].steps).toEqual(steps);
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test.skipIf(!postgresBin)("policy pre-create checks bind top-level Json arrays as jsonb", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        const steps = [{ code: "S1", detail: { approved: true } }] as never;
        // The fixture's owner policy is non-constant, so create/createMany run
        // the policy values-table preflight that must treat steps as one jsonb.
        await alice.commandStore.transaction(async session => {
          await session.transaction.db.note.create({ data: { id: "json-one", owner: "alice", value: 1, steps } });
          await session.transaction.db.note.createMany({ data: [
            { id: "json-many", owner: "alice", value: 2, steps },
            { id: "json-object", owner: "alice", value: 3, steps: { code: "object" } as never },
          ] });
        });
        const rows = await pool`SELECT id, jsonb_typeof(steps) AS kind, steps FROM "Note" ORDER BY id`;
        expect(rows.map((row: { id: string; kind: string }) => [row.id, row.kind])).toEqual([
          ["json-many", "array"], ["json-object", "object"], ["json-one", "array"],
        ]);
        expect(rows[0].steps).toEqual(steps);
        expect(rows[1].steps).toEqual({ code: "object" });
        expect(rows[2].steps).toEqual(steps);
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test.skipIf(!postgresBin)("readFunctionByRow resolves reviewed composite functions by primary key", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.exec(`
      CREATE SCHEMA helpers;
      CREATE FUNCTION helpers.note_dto(public."Note") RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT to_jsonb($1)';
      CREATE FUNCTION helpers.note_label(public."Note") RETURNS text LANGUAGE sql STABLE AS 'SELECT $1.owner';
      CREATE FUNCTION helpers.note_write(public."Note") RETURNS integer LANGUAGE plpgsql VOLATILE AS
        'BEGIN UPDATE public."Note" SET value = value + 1 WHERE id = $1.id; RETURN 1; END';
    `);
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        await alice.commandStore.transaction(async session => {
          await session.transaction.db.note.create({ data: { id: "row-1", owner: "alice", value: 7, steps: [{ code: "S1" }] as never } });
        });
        await alice.commandStore.transaction(async session => {
          expect(await session.transaction.readFunctionByRow("helpers.note_dto", { table: "public.Note", key: "id", value: "row-1" }))
            .toEqual({ id: "row-1", owner: "alice", value: 7, steps: [{ code: "S1" }] });
          expect(await session.transaction.readFunctionByRow("helpers.note_label", { table: "public.Note", key: "id", value: "row-1" })).toBe("alice");
          for (const call of [
            () => session.transaction.readFunctionByRow("helpers.note_dto", { table: 'public."Note"', key: "id", value: "row-1" }),
            () => session.transaction.readFunctionByRow("helpers.note_dto", { table: "public.Note", key: "id", value: "missing" }),
            () => session.transaction.readFunctionByRow("helpers.note_dto", { table: "public.Note", key: "owner", value: "alice" }),
            () => session.transaction.readFunctionByRow("helpers.note_dto", { table: "helpers.Note", key: "id", value: "row-1" }),
            () => session.transaction.readFunctionByRow("helpers.note_count", { table: "public.Note", key: "id", value: "row-1" }),
            () => session.transaction.readFunctionByRow("helpers.note_write", { table: "public.Note", key: "id", value: "row-1" }),
            () => session.transaction.readFunctionByRow("helpers.note_dto", { table: "public.Note", key: "id; DROP TABLE \"Note\"", value: "row-1" }),
          ]) {
            await expect(call()).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
          }
        });
        expect(await alice.models.note.count()).toBe(1);
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);

test.skipIf(!postgresBin)("callFunction preserves transaction scope and enforces security boundaries", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec("CREATE TABLE \"Note\" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL, steps jsonb NOT NULL DEFAULT '[]'::jsonb);");
    await server.exec(`
      CREATE ROLE other_owner NOLOGIN;
      CREATE FUNCTION public.test_note_upsert(p_id text, p_steps jsonb) RETURNS jsonb LANGUAGE plpgsql
        SECURITY DEFINER SET search_path = public AS $$
        BEGIN
          INSERT INTO public."Note"(id, owner, value, steps) VALUES (p_id, 'alice', 1, p_steps)
          ON CONFLICT (id) DO UPDATE SET steps = EXCLUDED.steps;
          RETURN jsonb_build_object('id', p_id, 'steps', p_steps);
        END $$;
      CREATE FUNCTION public.test_invoker(p_id text) RETURNS text LANGUAGE sql SET search_path = public AS 'SELECT p_id';
      CREATE FUNCTION public.test_no_search_path(p_id text) RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT p_id';
      CREATE FUNCTION public.test_user_search_path(p_id text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, "$user" AS 'SELECT p_id';
      CREATE FUNCTION public.test_other_owner(p_id text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT p_id';
      ALTER FUNCTION public.test_other_owner(text) OWNER TO other_owner;
      GRANT EXECUTE ON FUNCTION public.test_other_owner(text) TO current_user;
      CREATE FUNCTION public.test_no_rows() RETURNS TABLE(value integer) LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT value FROM public."Note" WHERE false';
      CREATE FUNCTION public.test_many_rows() RETURNS TABLE(value integer) LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT 1 UNION ALL SELECT 2';
      CREATE FUNCTION public.test_sqlstate() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
        'BEGIN RAISE EXCEPTION USING ERRCODE = ''23514'', MESSAGE = ''domain check failed''; END';
    `);
    await server.withConnection(async url => {
      const pool = new SQL(url, { max: 4 }); const db = createZenStackDatabase(schema, pool, {});
      try {
        const alice = db.forIdentity({ id: "alice" });
        // Same transaction: model write, function write and function result are visible together.
        await alice.commandStore.transaction(async session => {
          await session.transaction.db.note.create({ data: { id: "call-1", owner: "alice", value: 2 } });
          expect(await session.transaction.callFunction("public.test_note_upsert", ["call-1", [{ code: "S1" }]], { volatility: "volatile" }))
            .toEqual({ id: "call-1", steps: [{ code: "S1" }] });
          expect(await session.transaction.db.note.findUnique({ where: { id: "call-1" } })).toMatchObject({ steps: [{ code: "S1" }] });
        });
        expect(await alice.models.note.findUnique({ where: { id: "call-1" } })).toMatchObject({ steps: [{ code: "S1" }] });
        // A later failure rolls the function write back with the model write.
        await expect(alice.commandStore.transaction(async session => {
          await session.transaction.callFunction("public.test_note_upsert", ["rollback-1", [{ code: "S2" }]]);
          throw new Error("rollback");
        })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
        expect(await alice.models.note.findUnique({ where: { id: "rollback-1" } })).toBeNull();
        // Catalog and configuration boundaries fail before or instead of executing.
        await expect(alice.commandStore.transaction(async session => {
          for (const call of [
            () => session.transaction.callFunction("public.test_invoker", ["x"]),
            () => session.transaction.callFunction("public.test_no_search_path", ["x"]),
            () => session.transaction.callFunction("public.test_user_search_path", ["x"]),
            () => session.transaction.callFunction("public.test_other_owner", ["x"]),
            () => session.transaction.callFunction("public.test_no_rows"),
            () => session.transaction.callFunction("public.test_many_rows"),
            () => session.transaction.callFunction("public.test_note_upsert", ["x", [{ code: "S1" }]], { volatility: "stable" as never }),
            () => session.transaction.callFunction("public.test_note_upsert", ["x", undefined as never]),
            () => session.transaction.callFunction("helpers.missing", []),
          ]) {
            await expect(call()).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
          }
        }));
        // PostgreSQL SQLSTATE remains on the transaction failure cause; the
        // protocol outcome stays unknown because the transaction rolled back.
        const sqlstateFailure = await alice.commandStore.transaction(
          session => session.transaction.callFunction("public.test_sqlstate"),
        ).catch((error: unknown) => error);
        expect(sqlstateFailure).toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
        expect(sqlstateFailure).toMatchObject({ cause: { errno: "23514" } });
        // Configured trusted owners are explicit rather than implicit.
        const configured = createZenStackDatabase(schema, pool, { callFunction: { owners: ["other_owner"] } });
        try {
          const ownerScoped = configured.forIdentity({ id: "alice" });
          await ownerScoped.commandStore.transaction(async session => {
            expect(await session.transaction.callFunction("public.test_other_owner", ["ok"])).toBe("ok");
          });
        } finally { await configured.dispose(); }
      } finally { await db.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 30_000);
