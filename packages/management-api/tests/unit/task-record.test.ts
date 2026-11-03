import { expect, test } from "bun:test";
import {
  InvalidTaskRecordError, parseTaskRecord, parseTaskAttemptRecord, copyTaskJson,
} from "../../src/utils/task-record";
import { PROJECT_TASK_COLUMNS, projectTaskColumns, projectTaskRowSchema } from "../../src/db/contracts/task-row";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskAttemptFixture, taskFixture } from "../helpers/task-fixtures";

test("task rows validate native and legacy JSON without erasing empty objects or null", () => {
  for (const serialized of [false, true]) {
    const payload = { nested: { values: [null, 0, false, ""] } };
    const source = {
      ...taskFixture(), payload: serialized ? JSON.stringify(payload) : payload,
      result: serialized ? "{}" : {}, metadata: serialized ? '{"zero":0}' : { zero: 0 },
    };
    const task = parseTaskRecord(source);
    expect(task.payload).toEqual(payload);
    expect(task.result).toEqual({});
    expect(task.metadata).toEqual({ zero: 0 });
    expect(task.created_at).toBeInstanceOf(Date);
    expect(task.created_at).not.toBe(source.created_at);
    payload.nested.values.push("changed");
    expect(task.payload).not.toEqual(payload);
  }
  expect(parseTaskRecord(taskFixture()).result).toBeNull();
});

test("missing fields, damaged JSON and incorrect persisted scalar types cannot fabricate tasks", () => {
  for (const field of Object.keys(taskFixture())) {
    const missing: Record<string, unknown> = { ...taskFixture() };
    delete missing[field];
    expect(() => parseTaskRecord(missing)).toThrow(InvalidTaskRecordError);
  }
  for (const patch of [
    { status: "success" }, { attempt: "1" }, { attempt: -1 }, { retries: Infinity },
    { max_attempts: 0 }, { timeout_sec: 0 }, { next_run_at: "2026-01-01" },
    { created_at: new Date("invalid") }, { auth_authority_ref: null },
    { payload: null }, { payload: "{" }, { payload: "[]" }, { payload: "null" },
    { result: "false" }, { metadata: [] },
  ]) expect(() => parseTaskRecord({ ...taskFixture(), ...patch })).toThrow(InvalidTaskRecordError);
});

test("attempt rows validate all logs before returning any receipt", () => {
  const log = { timestamp: new Date(0).toISOString(), stream: "stdout" as const, level: "info", message: "ok" };
  const valid = { ...taskAttemptFixture(), logs: JSON.stringify([log]) };
  expect(parseTaskAttemptRecord(valid).logs).toEqual([log]);
  for (const patch of [
    { task_id: null }, { attempt_no: 0 }, { status: "success" }, { response_status: "200" },
    { response_status: 600 }, { duration_ms: NaN }, { logs: "{}" },
    { logs: [log, { ...log, message: false }] }, { logs: [{ ...log, timestamp: "invalid" }] },
    { logs: [{ ...log, stream: "console" }] },
  ]) expect(() => parseTaskAttemptRecord({ ...valid, ...patch })).toThrow(InvalidTaskRecordError);
});

test("JSON snapshots reject cycles, accessors and lossy serialization", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return "hidden"; } };
  for (const value of [cyclic, accessor, [undefined], new Array(3), { n: Infinity },
    { date: new Date() }, { value: 1n }, { missing: undefined }]) {
    expect(() => copyTaskJson(value)).toThrow(InvalidTaskRecordError);
  }
  expect(getterCalls).toBe(0);
});

test("the explicit task column list stays aligned with the row schema", () => {
  const columns = PROJECT_TASK_COLUMNS.split(",").map((column) => column.trim());
  expect(columns).toEqual(Object.keys(projectTaskRowSchema.properties));
});

test("explicit column fragments reject unsafe aliases and stay inlined in tagged SQL", () => {
  expect(projectTaskColumns("pt").startsWith("pt.id,")).toBe(true);
  expect(() => projectTaskColumns("pt;drop")).toThrow("Invalid SQL identifier");

  const root = join(import.meta.dir, "../../src");
  const files = [
    "repositories/task.repository.ts",
    "services/background-task.service.ts",
    "services/pgflow-task.service.ts",
  ];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    let index = 0;
    while (index < source.length) {
      const tick = source.indexOf("`", index);
      if (tick < 0) break;
      let start = tick - 1;
      while (start >= 0 && /[A-Za-z0-9_]/.test(source[start] ?? "")) start -= 1;
      const client = source.slice(start + 1, tick);
      const end = source.indexOf("`", tick + 1);
      if (end < 0) throw new Error(`unclosed template in ${file}`);
      if (client === "sql" || client === "transaction" || client === "tx") {
        const body = source.slice(tick + 1, end);
        if (/\$\{(?:projectTaskColumns\(|PROJECT_TASK_ATTEMPT_COLUMNS)/.test(body)
          && !/\$\{(?:sql|transaction|tx)\.unsafe\((?:projectTaskColumns\(|PROJECT_TASK_ATTEMPT_COLUMNS)/.test(body)) {
          throw new Error(`${file} binds a task column list instead of inlining it`);
        }
      }
      index = end + 1;
    }
  }
});
