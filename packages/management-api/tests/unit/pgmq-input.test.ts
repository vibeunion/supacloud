// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { pgmqCreateOptions, pgmqInteger, pgmqListOptions, pgmqSeconds, PgmqInputError } from "../../src/utils/pgmq-input";
import { taskProjectFixture } from "../helpers/task-fixtures";

test("integer inputs require exact numbers within their declared ranges", () => {
  for (const value of [0, 1, 2147483647]) expect(pgmqSeconds(value)).toBe(value);
  for (const value of [null, undefined, true, "", "0", "1", NaN, Infinity, -Infinity,
    -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER, {}, []]) {
    expect(() => pgmqSeconds(value)).toThrow(PgmqInputError);
  }
  expect(pgmqInteger(1, 1, 10000)).toBe(1);
  expect(pgmqInteger(10000, 1, 10000)).toBe(10000);
  for (const value of [0, 10001, 1.5, "1"]) {
    expect(() => pgmqInteger(value, 1, 10000)).toThrow(PgmqInputError);
  }
});

test("options are owned data fields, with exact booleans and no coercion or silent clamping", () => {
  expect(pgmqListOptions(undefined)).toEqual({ limit: 50, archived: false });
  expect(pgmqCreateOptions({})).toEqual({ unlogged: false });
  expect(pgmqListOptions({ limit: 500, archived: true })).toEqual({ limit: 500, archived: true });
  expect(pgmqListOptions(Object.create(null))).toEqual({ limit: 50, archived: false });
  for (const value of [null, [], true, "options", new Date(), { unknown: 1 },
    { [Symbol("archived")]: true }, Object.create({ archived: true })]) {
    expect(() => pgmqListOptions(value)).toThrow(PgmqInputError);
    expect(() => pgmqCreateOptions(value)).toThrow(PgmqInputError);
  }
  for (const value of [null, 0, 1, "", "false", {}, []]) {
    expect(() => pgmqListOptions({ archived: value })).toThrow(PgmqInputError);
    expect(() => pgmqCreateOptions({ unlogged: value })).toThrow(PgmqInputError);
  }
  for (const value of [null, 0, -1, 501, 1.9, "1", NaN, Infinity]) {
    expect(() => pgmqListOptions({ limit: value })).toThrow(PgmqInputError);
  }
  let getterCalls = 0;
  const getter = () => { getterCalls++; return true; };
  expect(() => pgmqListOptions(Object.defineProperty({}, "archived", { get: getter }))).toThrow(PgmqInputError);
  expect(() => pgmqCreateOptions(Object.defineProperty({}, "unlogged", { get: getter }))).toThrow(PgmqInputError);
  expect(getterCalls).toBe(0);
  const original = { limit: 1, archived: false };
  const captured = pgmqListOptions(original);
  original.limit = 500;
  original.archived = true;
  expect(captured).toEqual({ limit: 1, archived: false });
  expect(Object.isFrozen(captured)).toBe(true);
});

test("invalid scalar inputs stop every related service before project lookup or tenant setup", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  try {
    for (const value of [null, true, "1", NaN, Infinity, -1, 0.1, 2147483648]) {
      // Model callers bypassing the TypeScript signature at a runtime boundary.
      const seconds = value as number;
      for (const operation of [
        () => pgmqService.send("proj_1", "jobs", {}, seconds),
        () => pgmqService.sendBatch("proj_1", "jobs", [{}], seconds),
        () => pgmqService.sendBatch("proj_1", "jobs", [], seconds),
        () => pgmqService.read("proj_1", "jobs", seconds, 1),
        () => pgmqService.setVisibilityTimeout("proj_1", "jobs", "1", seconds),
      ]) await expect(operation()).rejects.toThrow(PgmqInputError);
    }
    for (const count of [0, -1, 10001, 1.5, NaN, Infinity]) {
      await expect(pgmqService.read("proj_1", "jobs", 0, count)).rejects.toThrow(PgmqInputError);
    }
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); }
});

test("invalid option objects stop services before setup and are never retried", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  try {
    for (const value of [null, [], { limit: 0 }, { limit: 1.1 }, { limit: "2" }, { archived: "false" }]) {
      const input: unknown = value;
      await expect(pgmqService.listMessages("proj_1", "jobs",
        input as Parameters<typeof pgmqService.listMessages>[2])).rejects.toThrow(PgmqInputError);
    }
    for (const value of [null, [], { unlogged: "false" }, { unlogged: 1 }, { unexpected: true }]) {
      const input: unknown = value;
      await expect(pgmqService.createQueue("proj_1", "jobs",
        input as Parameters<typeof pgmqService.createQueue>[2])).rejects.toThrow(PgmqInputError);
    }
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); }
});

test("creation and list retries retain the invocation's captured options", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  const create = { unlogged: false };
  const list = { archived: false, limit: 1 };
  const statements: string[] = [];
  const listArguments: unknown[][] = [];
  const connection = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      const template = args[0];
      if (!Array.isArray(template)) throw new Error("Expected SQL template");
      statements.push(template.join("?"));
      if (template.join("").includes("list_queues")) {
        return Promise.resolve([{
          queue_name: "jobs", created_at: null, is_partitioned: false, is_unlogged: false,
        }]);
      }
      return sql.unsafe("SELECT 1 WHERE 0");
    },
    get(target, key, receiver) {
      if (key !== "unsafe") return Reflect.get(target, key, receiver);
      return (text: string, values: unknown[]) => {
        statements.push(text);
        listArguments.push(values);
        if (listArguments.length === 1) throw new Error("Fixture transient listing failure");
        return sql.unsafe("SELECT 1 WHERE 0");
      };
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockImplementation(async () => {
    create.unlogged = true;
    list.archived = true;
    list.limit = 500;
    return taskProjectFixture({ ref: "proj_1", db_name: "tenant", deleted_at: null });
  });
  const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
  try {
    await pgmqService.createQueue("proj_1", "jobs", create);
    expect(statements.some(text => text.includes("pgmq.create("))).toBe(true);
    expect(statements.some(text => text.includes("pgmq.create_unlogged("))).toBe(false);
    list.archived = false;
    list.limit = 1;
    expect(await pgmqService.listMessages("proj_1", "jobs", list)).toEqual([]);
    expect(listArguments).toEqual([[1, false], [1, false]]);
    const listings = statements.filter(text => text.includes("ORDER BY"));
    expect(listings).toHaveLength(2);
    for (const text of listings) expect(text).toContain('FROM pgmq."q_jobs"');
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("validated seconds and counts reach SQL unchanged, including zero and maximum values", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const connection = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      const template = args[0];
      if (!Array.isArray(template)) throw new Error("Expected SQL template");
      const text = template.join("?");
      if (text.includes("CREATE EXTENSION")) return sql.unsafe("SELECT 1 WHERE 0");
      calls.push({ text, values: args.slice(1) });
      return sql.unsafe(text.includes("pgmq.send(") ? "SELECT '1' AS msg_id" : "SELECT 1 WHERE 0");
    },
    get(target, key, receiver) {
      if (key !== "unsafe") return Reflect.get(target, key, receiver);
      return (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return sql.unsafe("SELECT '1' AS msg_id");
      };
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(
    taskProjectFixture({ ref: "proj_1", db_name: "tenant", deleted_at: null }));
  const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
  try {
    for (const seconds of [0, 2147483647]) {
      calls.length = 0;
      await pgmqService.send("proj_1", "jobs", {}, seconds);
      await pgmqService.sendBatch("proj_1", "jobs", [{}], seconds);
      await pgmqService.read("proj_1", "jobs", seconds, 10000);
      await pgmqService.setVisibilityTimeout("proj_1", "jobs", "1", seconds);
      expect(calls.map(call => call.values)).toEqual([
        ["jobs", "{}", seconds], ["jobs", "{}", seconds], ["jobs", seconds, 10000], ["jobs", "1", seconds],
      ]);
    }
    expect(await pgmqService.sendBatch("proj_1", "jobs", [], 0)).toEqual([]);
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("input decoder compiles under strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-input.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
