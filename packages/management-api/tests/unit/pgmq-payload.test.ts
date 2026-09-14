// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { join } from "node:path";
import { serializePgmqPayload, PGMQ_MESSAGE_BYTES, PGMQ_BATCH_BYTES, PGMQ_BATCH_NODES } from "../../src/utils/pgmq-payload";
import { capturePgmqBatch } from "../../src/utils/pgmq-batch";
import { PgmqPayloadTooLargeError } from "../../src/utils/pgmq-input";
import { projectRepository } from "../../src/repositories/project.repository";
import * as database from "../../src/db";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskRoutes } from "../../src/routes/tasks";
import { config } from "../../src/config";

test("payload limit counts serialized UTF-8 bytes including quoting and escape expansion", () => {
  const exact = "a".repeat(PGMQ_MESSAGE_BYTES - 2);
  expect(Buffer.byteLength(serializePgmqPayload(exact))).toBe(PGMQ_MESSAGE_BYTES);
  expect(() => serializePgmqPayload(`${exact}a`)).toThrow(PgmqPayloadTooLargeError);
  expect(() => serializePgmqPayload("\u4e2d".repeat(Math.floor(PGMQ_MESSAGE_BYTES / 3) + 1))).toThrow(PgmqPayloadTooLargeError);
  expect(() => { serializePgmqPayload("\0".repeat(Math.floor(PGMQ_MESSAGE_BYTES / 6) + 1)); }).toThrow(PgmqPayloadTooLargeError);
  expect(() => { serializePgmqPayload("\ud800".repeat(Math.floor(PGMQ_MESSAGE_BYTES / 6) + 1)); }).toThrow(PgmqPayloadTooLargeError);
  expect(() => serializePgmqPayload({ ["x".repeat(PGMQ_MESSAGE_BYTES)]: true })).toThrow(PgmqPayloadTooLargeError);
  expect(serializePgmqPayload({ quote: '"', nested: [null, false, 1] })).toBe('{"quote":"\\"","nested":[null,false,1]}');
});

test("batch cumulative byte and node budgets apply across individually valid messages", () => {
  const message = "a".repeat(PGMQ_MESSAGE_BYTES - 2);
  const exact = capturePgmqBatch(Array.from({ length: 8 }, () => message));
  expect(exact.reduce((total, value) => total + Buffer.byteLength(value), 0)).toBe(PGMQ_BATCH_BYTES);
  expect(() => capturePgmqBatch([...Array.from({ length: 8 }, () => message), ""])).toThrow(PgmqPayloadTooLargeError);
  const tenNodes = { values: Array.from({ length: 8 }, () => 1) };
  expect(capturePgmqBatch(Array.from({ length: 10000 }, () => tenNodes))).toHaveLength(10000);
  const elevenNodes = { values: Array.from({ length: 9 }, () => 1) };
  expect(() => capturePgmqBatch(Array.from({ length: 10000 }, () => elevenNodes))).toThrow(PgmqPayloadTooLargeError);
  const budget = { remainingBytes: 2, remainingNodes: PGMQ_BATCH_NODES };
  expect(serializePgmqPayload({}, budget)).toBe("{}");
  expect(budget.remainingBytes).toBe(0);
  expect(() => serializePgmqPayload({}, budget)).toThrow(PgmqPayloadTooLargeError);
});

test("oversized single and batch sends fail before project lookup or tenant connection", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  try {
    const oversized = { value: "a".repeat(PGMQ_MESSAGE_BYTES) };
    await expect(pgmqService.send("proj_1", "jobs", oversized)).rejects.toThrow(PgmqPayloadTooLargeError);
    await expect(pgmqService.sendBatch("proj_1", "jobs", [{ ok: true }, oversized])).rejects.toThrow(PgmqPayloadTooLargeError);
    const large = { value: "a".repeat(PGMQ_MESSAGE_BYTES - 100) };
    await expect(pgmqService.sendBatch("proj_1", "jobs", Array.from({ length: 9 }, () => large))).rejects.toThrow(PgmqPayloadTooLargeError);
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); }
});

test("actual HTTP send routes return sanitized 413 from real service budget enforcement", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-pgmq-payload-test";
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  const app = new Elysia().use(taskRoutes);
  const request = (path: string, body: unknown) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ));
  try {
    const message = { value: "a".repeat(PGMQ_MESSAGE_BYTES) };
    for (const response of [await request("", { message }), await request("/batch", { messages: [message] })]) {
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ message: "Queue payload exceeds limits", code: "PGMQ_PAYLOAD_TOO_LARGE" });
    }
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); config.masterToken = previous; }
});

test("payload and batch helpers compile with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node",
      join(import.meta.dir, "../../src/utils/pgmq-payload.ts"), join(import.meta.dir, "../../src/utils/pgmq-batch.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
