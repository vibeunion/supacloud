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
    await server.exec('CREATE TABLE "Note" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL);');
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
const row: ModelResult<ModelSchema["schema"], "Note"> = { id: "1", owner: "alice", value: 1 };
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
