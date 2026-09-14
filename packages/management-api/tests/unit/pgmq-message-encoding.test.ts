// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { readPgmqJson, type PgmqJson } from "../../src/utils/pgmq-message-id";

test("native tagged and unsafe bindings parse serialized JSON exactly once through text", async () => {
  await withNativePostgres(async db => {
    const inputs: PgmqJson[] = [
      {}, { nested: [1, true, null, { text: 'quote " slash \\ newline\n' }] },
      ["array", 2], "plain", '{"looks":"encoded"}', "", null, false, 0, 1.5,
    ];
    for (const value of inputs) {
      const encoded = JSON.stringify(value);
      const tagged = await db`SELECT ${encoded}::text::jsonb AS message`;
      const unsafe = await db.unsafe("SELECT $1::text::jsonb AS message", [encoded]);
      expect(readPgmqJson(tagged[0].message)).toEqual(value);
      expect(readPgmqJson(unsafe[0].message)).toEqual(value);
    }
    // This is the regression: JSONB-typed parameters encode a JS string as a JSON string.
    const direct = await db`SELECT ${JSON.stringify({ a: 1 })}::jsonb AS message`;
    expect(direct[0].message).toBe('{"a":1}');
  });
}, 40_000);

test("actual send and batch SQL store object payloads without string wrapping", async () => {
  await withNativePostgres(async db => {
    await db`CREATE SCHEMA pgmq`;
    await db`CREATE TABLE pgmq.received (
      msg_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      queue_name text NOT NULL, message jsonb NOT NULL, delay_seconds integer NOT NULL
    )`;
    // Minimal receipt functions record parameters; they do not emulate PGMQ semantics.
    await db.unsafe(`
      CREATE FUNCTION pgmq.send(q text, payload jsonb, delay integer)
      RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO pgmq.received(queue_name, message, delay_seconds)
        VALUES(q, payload, delay) RETURNING msg_id
      $$;
      CREATE FUNCTION pgmq.send_batch(q text, payloads jsonb[], delay integer)
      RETURNS SETOF bigint LANGUAGE sql AS $$
        INSERT INTO pgmq.received(queue_name, message, delay_seconds)
        SELECT q, payload, delay FROM unnest(payloads) AS payload
        RETURNING msg_id
      $$;
    `);
    const connection = new Proxy(db, {
      apply(target, receiver, args: unknown[]) {
        const template = args[0];
        if (Array.isArray(template) && template.join("").includes("CREATE EXTENSION IF NOT EXISTS pgmq")) {
          return db`SELECT 1 WHERE false`;
        }
        return Reflect.apply(target, receiver, args);
      },
      get(target, key) {
        if (key === "unsafe") return target.unsafe.bind(target);
        return Reflect.get(target, key, target);
      },
    });
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(
      taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null }));
    const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
    try {
      const first = { string: '{"nested":true}', values: [false, null, 1], nested: { value: "before" } };
      expect(await pgmqService.send("proj_1", "jobs", first, 0)).toBe("1");
      const batch = [{ a: 1 }, { a: 'quote " and \\', nested: { yes: true } }, {}];
      expect(await pgmqService.sendBatch("proj_1", "jobs", batch, 7)).toEqual(["2", "3", "4"]);
      const rows = await db`SELECT message, jsonb_typeof(message) AS kind, delay_seconds FROM pgmq.received ORDER BY msg_id`;
      expect(rows.map((row: { message: unknown }) => readPgmqJson(row.message))).toEqual([first, ...batch]);
      expect(rows.map((row: { kind: unknown }) => row.kind)).toEqual(["object", "object", "object", "object"]);
      expect(rows.map((row: { delay_seconds: unknown }) => row.delay_seconds)).toEqual([0, 7, 7, 7]);

      const captured = { nested: { value: "original" } };
      find.mockImplementation(async () => {
        captured.nested.value = "modified during lookup";
        return taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null });
      });
      await pgmqService.send("proj_1", "jobs", captured);
      const sent = await db`SELECT message FROM pgmq.received WHERE msg_id = 5`;
      expect(sent[0].message).toEqual({ nested: { value: "original" } });
      captured.nested.value = "batch original";
      await pgmqService.sendBatch("proj_1", "jobs", [captured]);
      const sentBatch = await db`SELECT message FROM pgmq.received WHERE msg_id = 6`;
      expect(sentBatch[0].message).toEqual({ nested: { value: "batch original" } });
    } finally { find.mockRestore(); connect.mockRestore(); }
  });
}, 40_000);
