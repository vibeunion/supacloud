// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Elysia } from "elysia";
import { projectRepository } from "../../src/repositories/project.repository";
import { config } from "../../src/config";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskRoutes } from "../../src/routes/tasks";
import * as auth from "../../src/middleware/auth";
import { taskRepository } from "../../src/repositories/task.repository";
import { taskFixture } from "../helpers/task-fixtures";
import {
  assertPublicPgmqQueueName, PgmqInventoryError, pgmqSafeCount,
  readPgmqQueueInfo, readPgmqMetrics, readPgmqMetricsAll,
  readPgmqPurgeReceipt, readPgmqDropReceipt,
} from "../../src/utils/pgmq-inventory";

const stamp = "2026-09-10T00:00:00Z";
const info = { queue_name: "jobs", created_at: stamp, is_partitioned: false, is_unlogged: false };
const metric = {
  queue_name: "jobs", queue_length: "2", total_messages: "123",
  newest_msg_age_sec: "0", oldest_msg_age_sec: "42", scrape_time: stamp,
};

test("inventory validates flags, names and dates, strips extras and excludes reserved queues", () => {
  expect(readPgmqQueueInfo([{ ...info, secret: "hidden" }, {
    queue_name: "supacloud_internal_jobs",
  }])).toEqual([info]);
  expect(readPgmqQueueInfo([{ ...info, created_at: null }])[0]?.created_at).toBeNull();
  expect(readPgmqQueueInfo([])).toEqual([]);
  for (const value of [null, {}, [null], [info, info], [{ ...info, is_partitioned: "false" }],
    [{ ...info, is_unlogged: 0 }], [{ ...info, created_at: undefined }],
    [{ ...info, created_at: new Date(NaN) }], [{ ...info, queue_name: 123 }],
    [{ ...info, queue_name: "jobs/other" }], new Array(10001).fill(info),
  ]) expect(() => readPgmqQueueInfo(value)).toThrow(PgmqInventoryError);
  for (const name of ["", " Jobs", "jobs ", "JOBS", "jobs/other", "supacloud_internal_jobs", null, 1]) {
    expect(() => assertPublicPgmqQueueName(name)).toThrow(PgmqInventoryError);
  }
});

test("counts accept only exact nonnegative safe integers, never defaults or truthiness", () => {
  for (const value of [0, 1, "0", "1", 0n, 1n, Number.MAX_SAFE_INTEGER,
    String(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)]) {
    expect(pgmqSafeCount(value)).toBe(Number(value));
  }
  for (const value of [null, undefined, "", false, true, [], {}, -1, -1n, NaN, Infinity, 0.5,
    "01", "+1", "-0", "1e2", "1.0", " 1", "1 ", "9007199254740992",
    Number.MAX_SAFE_INTEGER + 1, 9007199254740992n, "9223372036854775807",
  ]) expect(() => pgmqSafeCount(value)).toThrow(PgmqInventoryError);
});

test("metrics require exact queue identity, row cardinality and each declared field", () => {
  expect(readPgmqMetrics([{ ...metric, raw: "hidden" }], "jobs")).toEqual({
    queue_name: "jobs", queue_length: 2, total_messages: 123,
    newest_msg_age_sec: 0, oldest_msg_age_sec: 42, scrape_time: stamp,
  });
  expect(readPgmqMetrics([], "jobs")).toBeNull();
  expect(readPgmqMetrics([{ ...metric, newest_msg_age_sec: null, oldest_msg_age_sec: null }], "jobs")?.oldest_msg_age_sec).toBeNull();
  expect(readPgmqMetrics([{ ...metric, newest_msg_age_sec: "-2" }], "jobs")?.newest_msg_age_sec).toBe(-2);
  for (const field of Object.keys(metric)) {
    const payload: Record<string, unknown> = { ...metric };
    delete payload[field];
    expect(() => readPgmqMetrics([payload], "jobs")).toThrow(PgmqInventoryError);
  }
  for (const value of [null, {}, [null], [metric, metric], [{ ...metric, queue_name: "other" }],
    [{ ...metric, queue_length: null }], [{ ...metric, total_messages: "9007199254740992" }],
    [{ ...metric, newest_msg_age_sec: false }], [{ ...metric, oldest_msg_age_sec: "" }],
    [{ ...metric, scrape_time: "invalid" }],
  ]) expect(() => readPgmqMetrics(value, "jobs")).toThrow(PgmqInventoryError);
});

test("all metrics reject duplicates and malformed public queues rather than hiding them", () => {
  expect(readPgmqMetricsAll([metric, { queue_name: "supacloud_internal_jobs" }])).toEqual([
    readPgmqMetrics([metric], "jobs"),
  ]);
  expect(readPgmqMetricsAll([])).toEqual([]);
  for (const value of [null, {}, [metric, metric], [{ queue_name: "jobs" }],
    [{ queue_name: undefined }], [{ ...metric, queue_name: "[object Object]" }]]) {
    expect(() => readPgmqMetricsAll(value)).toThrow(PgmqInventoryError);
  }
});

test("purge and drop receipts preserve legitimate zero and false but reject missing outcomes", () => {
  expect(readPgmqPurgeReceipt([{ purged: "0" }])).toBe(0);
  expect(readPgmqPurgeReceipt([{ purged: "123" }])).toBe(123);
  expect(readPgmqDropReceipt([{ dropped: false }])).toBe(false);
  expect(readPgmqDropReceipt([{ dropped: true }])).toBe(true);
  for (const value of [null, [], [{}], [{ purged: 0 }, { purged: 1 }], [{ purged: null }],
    [{ purged: "" }], [{ purged: "9223372036854775807" }]]) {
    expect(() => readPgmqPurgeReceipt(value)).toThrow(PgmqInventoryError);
  }
  for (const value of [null, [], [{}], [{ dropped: true }, { dropped: true }],
    [{ dropped: "false" }], [{ dropped: 1 }], [{ dropped: null }]]) {
    expect(() => readPgmqDropReceipt(value)).toThrow(PgmqInventoryError);
  }
});

test("invalid inventory names are rejected before database access", async () => {
  const resolver = spyOn(projectRepository, "findByRef").mockRejectedValue(new Error("Unexpected database access"));
  try {
    for (const name of ["", " jobs", "jobs/other", "supacloud_internal_jobs"]) {
      await expect(pgmqService.dropQueue("proj_1", name)).rejects.toThrow(PgmqInventoryError);
      await expect(pgmqService.purge("proj_1", name)).rejects.toThrow(PgmqInventoryError);
    }
    expect(resolver).not.toHaveBeenCalled();
  } finally { resolver.mockRestore(); }
});

test("actual routes distinguish uncertain mutations and sanitize read and setup failures", async () => {
  const oldToken = config.masterToken;
  config.masterToken = "synthetic-pgmq-inventory-test-token";
  const list = spyOn(pgmqService, "listQueues");
  const metrics = spyOn(pgmqService, "metrics");
  const drop = spyOn(pgmqService, "dropQueue");
  const purge = spyOn(pgmqService, "purge");
  const app = new Elysia().use(taskRoutes);
  const request = (path: string, method = "GET", authorized = true) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues${path}`,
    { method, headers: authorized ? { authorization: `Bearer ${config.masterToken}` } : {} },
  ));
  try {
    list.mockResolvedValue([info]);
    expect((await request("", "GET", false)).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(await (await request("")).json()).toEqual([info]);
    metrics.mockResolvedValue(null);
    expect((await request("/jobs/stats")).status).toBe(404);
    drop.mockResolvedValue(false);
    expect((await request("/jobs", "DELETE")).status).toBe(404);
    drop.mockResolvedValue(true);
    expect((await request("/jobs", "DELETE")).status).toBe(204);
    purge.mockResolvedValue(0);
    expect(await (await request("/jobs/purge", "POST")).json()).toEqual({ queue_name: "jobs", purged: 0 });
    for (const [spy, path, method] of [
      [drop, "/jobs", "DELETE"], [purge, "/jobs/purge", "POST"],
    ] as const) {
      spy.mockRejectedValue(new PgmqInventoryError(true));
      const response = await request(path, method);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true,
      });
    }
    list.mockRejectedValue(new Error("secret SQL statement"));
    metrics.mockRejectedValue(new Error("secret SQL statement"));
    drop.mockRejectedValue(new Error("secret SQL statement"));
    purge.mockRejectedValue(new Error("secret SQL statement"));
    for (const [path, method] of [["", "GET"], ["/jobs/stats", "GET"], ["/jobs", "DELETE"], ["/jobs/purge", "POST"]]) {
      const response = await request(path ?? "", method);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret");
    }
  } finally {
    list.mockRestore(); metrics.mockRestore(); drop.mockRestore(); purge.mockRestore();
    config.masterToken = oldToken;
  }
});

test("only the matched task-detail route uses invoker authorization, never static collections", async () => {
  const list = spyOn(pgmqService, "listQueues").mockRejectedValue(new Error("Must not read queues"));
  const stats = spyOn(taskRepository, "getTaskStats").mockRejectedValue(new Error("Must not read statistics"));
  const dlq = spyOn(taskRepository, "listTasksByProjectFiltered").mockRejectedValue(new Error("Must not read DLQ"));
  const detail = spyOn(taskRepository, "getTaskById").mockResolvedValue(taskFixture({
    id: "tsk_owned", project_ref: "proj_1", status: "succeeded",
    payload: { auth: { invoker_user_id: "user_1", authorization: "stored-secret", apikey: "stored-key" } },
  }));
  const attempts = spyOn(taskRepository, "listTaskAttempts").mockResolvedValue([]);
  const jwt = spyOn(auth, "verifyProjectJwt").mockResolvedValue({
    role: "authenticated", ref: "proj_1", sub: "user_1",
  });
  const app = new Elysia().use(taskRoutes);
  const request = (path: string, token?: string) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  ));
  try {
    for (const path of ["queues", "stats", "dlq"]) expect((await request(path)).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(dlq).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    const owned = await request("tsk_owned", "synthetic-owner-token");
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ payload: {
      auth: { invoker_user_id: "user_1", authorization: null, apikey: null },
    } });
    jwt.mockResolvedValue({ role: "authenticated", ref: "proj_1", sub: "user_2" });
    attempts.mockClear();
    expect((await request("tsk_owned", "synthetic-other-token")).status).toBe(403);
    expect(attempts).not.toHaveBeenCalled();
  } finally {
    list.mockRestore(); stats.mockRestore(); dlq.mockRestore(); detail.mockRestore();
    attempts.mockRestore(); jwt.mockRestore();
  }
});

test("service uses checked unknown results and text projections for integer counts", async () => {
  const source = await readFile(new URL("../../src/services/pgmq.service.ts", import.meta.url), "utf8");
  expect(source).toContain("pgmq.purge_queue(${queueName})::text AS purged");
  expect(source.match(/queue_length::text AS queue_length/g)).toHaveLength(2);
  expect(source.match(/total_messages::text AS total_messages/g)).toHaveLength(2);
  for (const decoder of ["readPgmqDropReceipt(rows)", "readPgmqPurgeReceipt(rows)",
    "readPgmqQueueInfo(rows)", "readPgmqMetrics(rows, queueName)", "readPgmqMetricsAll(rows)"]) {
    expect(source).toContain(decoder);
  }
  expect(source).not.toContain("Boolean(row");
  expect(source).not.toContain("Number(row");
  expect(source).not.toContain("as Record<string, unknown>[]");
});

test("inventory decoder module compiles with strict and full library checks", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../../supacloud-js/node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-inventory.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
