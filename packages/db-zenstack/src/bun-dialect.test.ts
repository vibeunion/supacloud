import { expect, test } from "bun:test";
import { CompiledQuery } from "kysely";
import { BunPostgresDialect, type BunSqlPool } from "./bun-dialect";
import { createZenStackDatabase } from "./zenstack";
import { schema } from "../tests/fixtures/model/generated/schema";

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
