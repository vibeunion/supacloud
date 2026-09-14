// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Elysia } from "elysia";
import { projectRepository } from "../../src/repositories/project.repository";
import { config } from "../../src/config";
import { pgmqService, type PgmqMessage } from "../../src/services/pgmq.service";
import { taskRoutes } from "../../src/routes/tasks";
import {
  parsePgmqMessageId, readPgmqIdReceipt, readPgmqIdReceipts, readPgmqMessageRows,
  readPgmqJson, readPgmqTimestamp, readPgmqBooleanReceipt,
} from "../../src/utils/pgmq-message-id";
import { withNativePostgres } from "../helpers/native-postgres";

const maximum = "9223372036854775807";

test("message ID contracts preserve int64 values and reject noncanonical or rounded input", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER, 1n, BigInt(maximum), "9007199254740993", maximum]) {
    expect(parsePgmqMessageId(value)).toBe(String(value));
  }
  for (const value of [0, -1, 0n, -1n, 9223372036854775808n, Number.MAX_SAFE_INTEGER + 1,
    1.5, NaN, Infinity, null, undefined, true, [], [1], {}, "", "01", "+1", "1.0", "1e2",
    " 1", "1 ", "9223372036854775808", "1/../../other",
  ]) expect(() => parsePgmqMessageId(value)).toThrow("Invalid PGMQ message ID");
});

test("ID and boolean receipts never silently drop rows, invent zero or coerce success", () => {
  expect(readPgmqIdReceipt([{ msg_id: maximum }])).toBe(maximum);
  expect(readPgmqIdReceipts([{ msg_id: 1 }, { msg_id: maximum }], 2)).toEqual(["1", maximum]);
  for (const value of [null, {}, [], [{ send: 1 }], [{ msg_id: 0 }], [{ msg_id: 1 }, { msg_id: 2 }]]) {
    expect(() => readPgmqIdReceipt(value)).toThrow();
  }
  expect(() => readPgmqIdReceipts([{ msg_id: 1 }, { msg_id: "1" }], 2)).toThrow("Duplicate");
  expect(() => readPgmqIdReceipts([{ msg_id: 1 }], 2)).toThrow("count");
  expect(readPgmqBooleanReceipt([{ archived: false }], "archived")).toBe(false);
  expect(readPgmqBooleanReceipt([{ deleted: true }], "deleted")).toBe(true);
  for (const value of [[], null, [{}], [{ archived: "false" }], [{ archived: 1 }], [{ archived: true }, { archived: true }]]) {
    expect(() => readPgmqBooleanReceipt(value, "archived")).toThrow();
  }
});

test("row identity and JSON decoding preserve real values without empty object fallbacks", () => {
  expect(readPgmqMessageRows([], 1)).toEqual([]);
  expect(readPgmqMessageRows([{ msg_id: maximum, message: null }], 1)[0]?.msg_id).toBe(maximum);
  for (const value of [null, {}, [null], [{ msg_id: 1 }, { msg_id: 1 }], [{ msg_id: 0 }]]) {
    expect(() => readPgmqMessageRows(value, 1)).toThrow();
  }
  for (const value of [null, false, 1, "plain JSON string", '{"not":"an encoded object"}', [1, null], { a: [false] }]) {
    expect(readPgmqJson(value)).toEqual(value);
  }
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), { x: undefined }]) {
    expect(() => readPgmqJson(value)).toThrow();
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => readPgmqJson(cyclic)).toThrow();
  let getters = 0;
  expect(() => readPgmqJson(Object.defineProperty({}, "x", {
    enumerable: true, get() { getters++; return 1; },
  }))).toThrow();
  expect(getters).toBe(0);
  expect(readPgmqTimestamp(new Date(0))).toEqual(new Date(0));
  expect(() => readPgmqTimestamp(new Date(NaN))).toThrow();
  expect(() => readPgmqTimestamp(undefined)).toThrow();
});

test("invalid service inputs stop before project database resolution", async () => {
  const resolver = spyOn(projectRepository, "findByRef").mockRejectedValue(new Error("Must not touch the database"));
  try {
    for (const id of [0, Number.MAX_SAFE_INTEGER + 1, "1.0", "9223372036854775808"]) {
      await expect(pgmqService.archive("proj_1", "jobs", id)).rejects.toThrow("Invalid PGMQ message ID");
      await expect(pgmqService.deleteMessage("proj_1", "jobs", id)).rejects.toThrow("Invalid PGMQ message ID");
      await expect(pgmqService.setVisibilityTimeout("proj_1", "jobs", id, 1)).rejects.toThrow("Invalid PGMQ message ID");
    }
    await expect(pgmqService.send("proj_1", "jobs", { invalid: undefined })).rejects.toThrow("Invalid PGMQ JSON");
    await expect(pgmqService.sendBatch("proj_1", "jobs", [{ invalid: undefined }])).rejects.toThrow("Invalid PGMQ operation input");
    await expect(pgmqService.read("proj_1", "jobs", 0, 1.5)).rejects.toThrow("Invalid PGMQ operation input");
    expect(resolver).not.toHaveBeenCalled();
  } finally { resolver.mockRestore(); }
});

test("Management routes retain large IDs through visibility, archive and delete", async () => {
  const oldToken = config.masterToken;
  config.masterToken = "synthetic-pgmq-test-management-token";
  const message: PgmqMessage = {
    id: maximum, msg_id: maximum, read_ct: 1, enqueued_at: new Date(0), vt: new Date(5000),
    message: null, payload: null, task_type: "queue:jobs", status: "leased",
  };
  const archive = spyOn(pgmqService, "archive").mockResolvedValue(true);
  const remove = spyOn(pgmqService, "deleteMessage").mockResolvedValue(true);
  const visibility = spyOn(pgmqService, "setVisibilityTimeout").mockResolvedValue(message);
  const app = new Elysia().use(taskRoutes);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.handle(request) });
  const headers = { authorization: `Bearer ${config.masterToken}` };
  try {
    const base = `${server.url.origin}/v1/projects/proj_1/tasks/queues/jobs/messages`;
    const released = await fetch(`${base}/${maximum}/release`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sleep_seconds: 5 }),
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ id: maximum, msg_id: maximum });
    expect(visibility).toHaveBeenLastCalledWith("proj_1", "jobs", maximum, 5);
    const ack = await fetch(`${base}/${maximum}/ack`, { method: "POST", headers });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({ id: maximum, msg_id: maximum });
    expect(archive).toHaveBeenLastCalledWith("proj_1", "jobs", maximum);
    const deleted = await fetch(`${base}/${maximum}`, { method: "DELETE", headers });
    expect(deleted.status).toBe(204);
    expect(remove).toHaveBeenLastCalledWith("proj_1", "jobs", maximum);
    archive.mockClear(); remove.mockClear(); visibility.mockClear();
    for (const id of ["01", "+1", "1e2", "1.0", "9223372036854775808"]) {
      for (const [suffix, method] of [["/ack", "POST"], ["/release", "POST"], ["", "DELETE"]] as const) {
        const response = await fetch(`${base}/${encodeURIComponent(id)}${suffix}`, { method, headers });
        expect(response.status).toBe(400);
      }
    }
    expect(archive).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(visibility).not.toHaveBeenCalled();
  } finally {
    archive.mockRestore(); remove.mockRestore(); visibility.mockRestore();
    config.masterToken = oldToken;
    await server.stop(true);
  }
});

test("service SQL requests text IDs and keeps numeric ordering and bigint binding explicit", async () => {
  const source = await readFile(new URL("../../src/services/pgmq.service.ts", import.meta.url), "utf8");
  expect(source.match(/msg_id::text AS msg_id/g)).toHaveLength(6);
  expect(source).toContain("ORDER BY q.msg_id DESC");
  expect(source).not.toContain("ORDER BY msg_id DESC");
  expect(source.match(/\$\{id\}::bigint/g)).toHaveLength(3);
  expect(source).not.toContain("normalizeMsgId");
});

test("native PostgreSQL and Bun SQL preserve int64 text values and numeric ordering", async () =>
  withNativePostgres(async db => {
    await db.unsafe("CREATE TABLE queue_id_fixture (msg_id bigint PRIMARY KEY)");
    const ids = ["2", "10", "9007199254740993", maximum];
    for (const id of ids) {
      await db`INSERT INTO queue_id_fixture(msg_id) VALUES (${id}::bigint)`;
      const rows: unknown = await db`SELECT ${id}::bigint::text AS msg_id`;
      expect(readPgmqIdReceipt(rows)).toBe(id);
    }
    const ordered: unknown = await db.unsafe(
      "SELECT q.msg_id::text AS msg_id FROM queue_id_fixture AS q ORDER BY q.msg_id DESC",
    );
    expect(readPgmqIdReceipts(ordered, 4)).toEqual([...ids].reverse());
    const driverValues: unknown = await db`
      SELECT msg_id::text AS msg_id, 'plain JSON string'::text AS label,
        '"plain JSON string"'::jsonb AS message
      FROM queue_id_fixture WHERE msg_id = ${maximum}::bigint
    `;
    const row = readPgmqMessageRows(driverValues, 1)[0];
    expect(readPgmqJson(row?.message)).toBe("plain JSON string");
  }), 40_000);
