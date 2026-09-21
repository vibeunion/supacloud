// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { capturePgmqBatch } from "../../src/utils/pgmq-batch";
import { PgmqInputError } from "../../src/utils/pgmq-input";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import * as database from "../../src/db";
import { taskProjectFixture } from "../helpers/task-fixtures";

test("batch capture preserves every own array slot and rejects holes and extra properties", () => {
  expect(capturePgmqBatch([])).toEqual([]);
  expect(capturePgmqBatch([{}, { a: [null, false, "text"] }])).toEqual(["{}", '{"a":[null,false,"text"]}']);
  expect(capturePgmqBatch([null, false, 0, "", []])).toEqual(["null", "false", "0", '""', "[]"]);
  expect(capturePgmqBatch(Object.freeze([{}]))).toEqual(["{}"]);
  expect(capturePgmqBatch(Array.from({ length: 10000 }, () => ({})))).toHaveLength(10000);
  const nonEnumerable = [{}];
  Object.defineProperty(nonEnumerable, "0", { enumerable: false });
  expect(capturePgmqBatch(nonEnumerable)).toEqual(["{}"]);
  for (const value of [
    null, {}, "[]", new Array(1), new Array(10001), [undefined],
    Object.assign([{}], { other: true }), Object.assign([{}], { [Symbol("other")]: true }),
    Object.setPrototypeOf([{}], null), new (class extends Array {})(),
  ]) expect(() => capturePgmqBatch(value)).toThrow(PgmqInputError);
});

test("capture does not invoke index getters, overridden map or custom serialization", () => {
  let calls = 0;
  const accessor = [{}];
  Object.defineProperty(accessor, "0", { get() { calls++; return {}; } });
  const overridden = Object.assign([{}], { map() { calls++; return []; } });
  const serializer = [{ toJSON() { calls++; return {}; } }];
  const nested = [{ get payload() { calls++; return {}; } }];
  for (const value of [accessor, overridden, serializer, nested]) {
    expect(() => capturePgmqBatch(value)).toThrow(PgmqInputError);
  }
  expect(calls).toBe(0);
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  expect(() => capturePgmqBatch(cyclic)).toThrow(PgmqInputError);
});

test("the whole invalid batch is rejected before project lookup or tenant connection", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  try {
    for (const value of [new Array(2), [{ valid: true }, { invalid: undefined }],
      [{ valid: true }, { invalid: Infinity }], Object.assign([{}], { other: true })]) {
      const wire: unknown = value;
      await expect(pgmqService.sendBatch("proj_1", "jobs",
        wire as Parameters<typeof pgmqService.sendBatch>[2])).rejects.toThrow(PgmqInputError);
    }
    expect(await pgmqService.sendBatch("proj_1", "jobs", [])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); }
});

test("SQL dispatch retains the complete captured batch when caller mutates it during lookup", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  const messages = [{ nested: { value: 1 } }, { nested: { value: 2 } }];
  let params: unknown[] = [];
  let statement = "";
  let writes = 0;
  const db = new Proxy(sql, {
    apply() { return sql.unsafe("SELECT 1 WHERE 0"); },
    get(target, key, receiver) {
      if (key !== "unsafe") return Reflect.get(target, key, receiver);
      return (text: string, values: unknown[]) => {
        writes++;
        statement = text;
        params = values;
        return sql.unsafe("SELECT '1' AS msg_id UNION ALL SELECT '2' AS msg_id");
      };
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockImplementation(async () => {
    const first = messages[0];
    if (!first) throw new Error("Missing fixture message");
    first.nested.value = 99;
    messages.pop();
    return taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null });
  });
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    expect(await pgmqService.sendBatch("proj_1", "jobs", messages, 3)).toEqual(["1", "2"]);
    expect(writes).toBe(1);
    expect(params).toEqual(["jobs", '{"nested":{"value":1}}', '{"nested":{"value":2}}', 3]);
    expect(statement).toContain("ARRAY[$2::text::jsonb, $3::text::jsonb]");
    expect(statement).toContain("$4");
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("batch decoder compiles with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../../supacloud-js/node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-batch.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
