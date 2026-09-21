// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { join } from "node:path";
import { config } from "../../src/config";
import { taskRoutes } from "../../src/routes/tasks";
import { projectService } from "../../src/services";
import { pgmqService } from "../../src/services/pgmq.service";
import { pgmqHttpDelay, pgmqHttpList, pgmqHttpReceive, pgmqHttpReceiveSettings } from "../../src/utils/pgmq-http-input";
import { PgmqInputError } from "../../src/utils/pgmq-input";

const settings = {
  max_in_flight: 10, default_visibility_timeout_sec: 330,
  max_attempts: 3, rate_limit_per_minute: 100,
};

function harness() {
  const previousToken = config.masterToken;
  config.masterToken = "synthetic-pgmq-http-input-test";
  const app = new Elysia().use(taskRoutes);
  return {
    close() { config.masterToken = previousToken; },
    request(path: string, body?: unknown, method = "POST", authorized = true) {
      const headers = new Headers();
      if (authorized) headers.set("authorization", `Bearer ${config.masterToken}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      return app.handle(new Request(`http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    },
  };
}

test("delay aliases are individually validated and must agree after millisecond conversion", () => {
  expect(pgmqHttpDelay({})).toBe(0);
  expect(pgmqHttpDelay({ sleepSeconds: 0, sleep_seconds: 0, delayMs: 999 })).toBe(0);
  expect(pgmqHttpDelay({ sleepSeconds: 1, sleep_seconds: 1, delayMs: 1999 })).toBe(1);
  expect(pgmqHttpDelay({ delayMs: 2592000000 })).toBe(2592000);
  for (const input of [
    { sleepSeconds: -1 }, { sleep_seconds: 0.1 }, { sleepSeconds: 2592001 },
    { delayMs: -1 }, { delayMs: 0.5 }, { delayMs: 2592000001 },
    { sleepSeconds: 0, sleep_seconds: 1 }, { sleep_seconds: 1, delayMs: 2000 },
    { sleepSeconds: 0, delayMs: NaN }, { sleepSeconds: 0, sleep_seconds: null },
    { sleepSeconds: "1" }, { delayMs: Infinity },
  ]) expect(() => pgmqHttpDelay(input)).toThrow(PgmqInputError);
});

test("receive and listing decoders reject invalid, ambiguous and noncanonical fields", () => {
  expect(pgmqHttpReceive({})).toEqual({ seconds: undefined, count: undefined });
  expect(pgmqHttpReceive({ n: 1, count: 1, sleep_seconds: 1800, visibilityTimeoutSec: 1800 }))
    .toEqual({ seconds: 1800, count: 1 });
  for (const input of [
    { n: 0 }, { count: 1.1 }, { n: 10001 }, { n: 1, count: 2 },
    { sleep_seconds: 0 }, { visibilityTimeoutSec: 1801 },
    { sleep_seconds: 1, visibilityTimeoutSec: 2 }, { count: "1" },
  ]) expect(() => pgmqHttpReceive(input)).toThrow(PgmqInputError);
  expect(pgmqHttpList({})).toEqual({ archived: false, limit: 50 });
  expect(pgmqHttpList({ archived: "true", dlq: "true", limit: "500" })).toEqual({ archived: true, limit: 500 });
  for (const limit of ["0", "501", "01", "1.0", "1e2", " 1", "+1", "", "Infinity", 1, null]) {
    expect(() => pgmqHttpList({ limit })).toThrow(PgmqInputError);
  }
  for (const input of [{ archived: "yes" }, { dlq: "1" }, { archived: true },
    { archived: "true", dlq: "false" }]) {
    expect(() => pgmqHttpList(input)).toThrow(PgmqInputError);
  }
  expect(pgmqHttpReceiveSettings(settings)).toEqual({ maxCount: 10, defaultSeconds: 330 });
  for (const input of [null, {}, { ...settings, max_in_flight: 0 },
    { ...settings, default_visibility_timeout_sec: "330" }]) {
    expect(() => pgmqHttpReceiveSettings(input)).toThrow("Invalid PGMQ receive settings");
  }
});

test("actual send, batch and release routes reject invalid delay input before dispatch", async () => {
  const h = harness();
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const batch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1"]);
  const release = spyOn(pgmqService, "setVisibilityTimeout").mockResolvedValue(null);
  try {
    for (const path of ["", "/batch", "/1/release"]) {
      for (const input of [
        { sleep_seconds: -1 }, { sleep_seconds: 1.1 }, { sleep_seconds: 2592001 },
        { delayMs: -1 }, { delayMs: 0.5 }, { delayMs: 2592000001 },
        { sleep_seconds: 1, delayMs: 2000 },
      ]) {
        const response = await h.request(path, { ...input, ...(path === "/batch" ? { messages: [{}] } : {}) });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
      }
    }
    for (const path of ["", "/batch"]) {
      expect((await h.request(path, { sleepSeconds: 1, sleep_seconds: 2, messages: [{}] })).status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  } finally { send.mockRestore(); batch.mockRestore(); release.mockRestore(); h.close(); }
});

test("actual routes preserve valid delays, defaults and exact service arguments", async () => {
  const h = harness();
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const batch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1"]);
  const release = spyOn(pgmqService, "setVisibilityTimeout").mockResolvedValue(null);
  try {
    expect((await h.request("", { message: { a: 1 }, sleepSeconds: 1, sleep_seconds: 1, delayMs: 1999 })).status).toBe(202);
    expect(send).toHaveBeenLastCalledWith("proj_1", "jobs", { a: 1 }, 1);
    expect((await h.request("", {})).status).toBe(202);
    expect(send).toHaveBeenLastCalledWith("proj_1", "jobs", {}, 0);
    expect((await h.request("/batch", { messages: [{ a: 1 }], delayMs: 2592000000 })).status).toBe(202);
    expect(batch).toHaveBeenLastCalledWith("proj_1", "jobs", [{ a: 1 }], 2592000);
    expect((await h.request("/1/release")).status).toBe(404);
    expect(release).toHaveBeenLastCalledWith("proj_1", "jobs", "1", 0);
    expect((await h.request("/1/release", { sleep_seconds: 1, delayMs: 1999 })).status).toBe(404);
    expect(release).toHaveBeenLastCalledWith("proj_1", "jobs", "1", 1);
  } finally { send.mockRestore(); batch.mockRestore(); release.mockRestore(); h.close(); }
});

test("receive rejects invalid requests before settings lookup and refuses exceeding configured counts", async () => {
  const h = harness();
  const getSettings = spyOn(projectService, "getQueueSettings").mockResolvedValue(settings);
  const read = spyOn(pgmqService, "read").mockResolvedValue([]);
  try {
    for (const input of [
      { n: 0 }, { count: 1.5 }, { n: 1, count: 2 }, { n: 10001 },
      { sleep_seconds: 0 }, { visibilityTimeoutSec: 1801 },
      { sleep_seconds: 1, visibilityTimeoutSec: 2 },
    ]) expect((await h.request("/receive", input)).status).toBe(400);
    expect(getSettings).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect((await h.request("/receive", { count: 11 })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect((await h.request("/receive", { n: 10, count: 10, sleep_seconds: 1800 })).status).toBe(204);
    expect(read).toHaveBeenLastCalledWith("proj_1", "jobs", 1800, 10);
    expect((await h.request("/receive")).status).toBe(204);
    expect(read).toHaveBeenLastCalledWith("proj_1", "jobs", 330, 1);
    getSettings.mockResolvedValue({ ...settings, max_in_flight: 0 });
    read.mockClear();
    const response = await h.request("/receive", {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("settings");
    expect(read).not.toHaveBeenCalled();
  } finally { getSettings.mockRestore(); read.mockRestore(); h.close(); }
});

test("receive retains single versus explicit-count array response shapes", async () => {
  const h = harness();
  const getSettings = spyOn(projectService, "getQueueSettings").mockResolvedValue(settings);
  const message = {
    id: "1", msg_id: "1", read_ct: 1, enqueued_at: "2026-09-10T00:00:00Z",
    vt: "2026-09-10T00:05:00Z", message: {}, payload: {}, status: "leased", task_type: "queue:jobs",
  } as const;
  const read = spyOn(pgmqService, "read").mockResolvedValue([message]);
  try {
    expect(await (await h.request("/receive")).json()).toEqual(message);
    expect(await (await h.request("/receive", { n: 1 })).json()).toEqual([message]);
    expect(await (await h.request("/receive", { count: 1 })).json()).toEqual([message]);
  } finally { getSettings.mockRestore(); read.mockRestore(); h.close(); }
});

test("listing requires canonical query values and consistent archive aliases", async () => {
  const h = harness();
  const list = spyOn(pgmqService, "listMessages").mockResolvedValue([]);
  try {
    for (const query of ["limit=0", "limit=501", "limit=1.5", "limit=01", "limit=1e2",
      "limit=%201", "archived=1", "dlq=yes", "archived=true&dlq=false"]) {
      expect((await h.request(`?${query}`, undefined, "GET")).status).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    expect((await h.request("?archived=true&dlq=true&limit=500", undefined, "GET")).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith("proj_1", "jobs", { archived: true, limit: 500 });
    expect((await h.request("", undefined, "GET")).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith("proj_1", "jobs", { archived: false, limit: 50 });
  } finally { list.mockRestore(); h.close(); }
});

test("auth and schema failures do not dispatch; backend errors are sanitized on all changed routes", async () => {
  const h = harness();
  const send = spyOn(pgmqService, "send").mockRejectedValue(new Error("secret database credentials"));
  const batch = spyOn(pgmqService, "sendBatch").mockRejectedValue(new Error("secret database credentials"));
  const release = spyOn(pgmqService, "setVisibilityTimeout").mockRejectedValue(new Error("secret database credentials"));
  const read = spyOn(pgmqService, "read").mockRejectedValue(new Error("secret database credentials"));
  const list = spyOn(pgmqService, "listMessages").mockRejectedValue(new Error("secret database credentials"));
  const getSettings = spyOn(projectService, "getQueueSettings").mockResolvedValue(settings);
  try {
    for (const path of ["", "/batch", "/receive", "/1/release"]) {
      const body = path === "/batch" ? { messages: [{}] } : {};
      expect((await h.request(path, body, "POST", false)).status).toBe(401);
    }
    expect(send).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    for (const value of ["1", null, true]) {
      const response = await h.request("", { sleep_seconds: value });
      expect([400, 422]).toContain(response.status);
    }
    expect(send).not.toHaveBeenCalled();
    for (const path of ["", "/batch", "/receive", "/1/release"]) {
      const response = await h.request(path, path === "/batch" ? { messages: [{}] } : {});
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret");
    }
    const response = await h.request("", undefined, "GET");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  } finally {
    send.mockRestore(); batch.mockRestore(); release.mockRestore(); read.mockRestore();
    list.mockRestore(); getSettings.mockRestore(); h.close();
  }
});

test("HTTP input decoder compiles with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../../supacloud-js/node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-http-input.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
