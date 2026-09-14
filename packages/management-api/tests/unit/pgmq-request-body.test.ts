// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { join } from "node:path";
import { readPgmqRequestBody, PGMQ_SEND_BODY_BYTES, PGMQ_BATCH_BODY_BYTES, PGMQ_BODY_MAX_CHUNKS } from "../../src/utils/pgmq-request-body";
import { taskRoutes } from "../../src/routes/tasks";
import { pgmqService } from "../../src/services/pgmq.service";
import { config } from "../../src/config";
import * as auth from "../../src/middleware/auth";

function request(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/body", {
    method: "POST", body, headers: { "content-type": "application/json", ...headers },
    ...(signal === undefined ? {} : { signal }),
  });
}

test("strict JSON reader measures bytes, supports split UTF-8 and rejects malformed content", async () => {
  expect(await readPgmqRequestBody(request('{"a":1}'), 7)).toEqual({ a: 1 });
  await expect(readPgmqRequestBody(request('{"a":1}'), 6)).rejects.toMatchObject({ status: 413 });
  const bytes = new TextEncoder().encode('{"a":"\u4e2d"}');
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  expect(await readPgmqRequestBody(request(split), bytes.length)).toEqual({ a: "\u4e2d" });
  for (const body of ["", "{", '{"secret":', "\ufeff{}"]) {
    await expect(readPgmqRequestBody(request(body), 100)).rejects.toMatchObject({ status: 400 });
  }
  await expect(readPgmqRequestBody(request(Uint8Array.of(0xff)), 100)).rejects.toMatchObject({ status: 400 });
  await expect(readPgmqRequestBody(request("{}", { "content-type": "text/plain" }), 100)).rejects.toMatchObject({ status: 415 });
  await expect(readPgmqRequestBody(request("{}", { "content-encoding": "gzip" }), 100)).rejects.toMatchObject({ status: 415 });
  expect(await readPgmqRequestBody(request("{}", { "content-type": 'application/json; charset="UTF-8"' }), 2)).toEqual({});
});

test("declared length is checked but cannot bypass actual streamed byte accounting", async () => {
  for (const length of ["-1", "01", "1.5", "x"]) {
    await expect(readPgmqRequestBody(request("{}", { "content-length": length }), 100)).rejects.toMatchObject({ status: 400 });
  }
  await expect(readPgmqRequestBody(request("{}", { "content-length": "101" }), 100)).rejects.toMatchObject({ status: 413 });
  for (const length of ["0", "1", "3"]) {
    await expect(readPgmqRequestBody(request("{}", { "content-length": length }), 100)).rejects.toMatchObject({ status: 400 });
  }
  expect(await readPgmqRequestBody(request("{}", { "content-length": "2" }), 2)).toEqual({});
});

test("overflow and stalled or aborted streams are cancelled without waiting for cleanup", async () => {
  let cancelled = 0;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelled++; return new Promise<void>(() => {}); },
  });
  await expect(readPgmqRequestBody(request(oversized), 10)).rejects.toMatchObject({ status: 413 });
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  await expect(readPgmqRequestBody(request(stalled), 100, 10)).rejects.toMatchObject({ status: 408 });
  const controller = new AbortController();
  const interrupted = readPgmqRequestBody(request(new ReadableStream<Uint8Array>({
    cancel() { cancelled++; },
  }), {}, controller.signal), 100);
  controller.abort();
  await expect(interrupted).rejects.toMatchObject({ status: 400 });
  expect(cancelled).toBe(3);
});

test("actual send routes apply pre-parser limits and retain schema and authorization checks", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-body-limit-token";
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const batch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1"]);
  const app = new Elysia().use(taskRoutes);
  const call = (path: string, body: BodyInit, authorized = true, type = "application/json") =>
    app.handle(new Request(`http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`, {
      method: "POST", body, headers: {
        "content-type": type, ...(authorized ? { authorization: `Bearer ${config.masterToken}` } : {}),
      },
    }));
  try {
    for (const [path, limit] of [["", PGMQ_SEND_BODY_BYTES], ["/batch", PGMQ_BATCH_BODY_BYTES]] as const) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(limit + 1)); controller.close(); },
      });
      const response = await call(path, stream);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        message: "Queue request body could not be accepted", code: "PGMQ_REQUEST_BODY_INVALID",
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect((await call("", '{"message":{}}', false)).status).toBe(401);
    expect((await call("", '{"message":{}}', true, "text/plain")).status).toBe(415);
    expect((await call("", "{")).status).toBe(400);
    for (const body of ['{"message":1}', '{"payload":null}', '{"message":[]}', "null", "[]"]) {
      expect((await call("", body)).status).toBe(400);
    }
    expect((await call("/batch", '{"messages":[1]}')).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect((await call("", '{"message":{"a":1}}')).status).toBe(202);
    expect(send).toHaveBeenLastCalledWith("proj_1", "jobs", { a: 1 }, 0);
    expect((await call("/batch", '{"messages":[{}]}')).status).toBe(202);
    expect(batch).toHaveBeenLastCalledWith("proj_1", "jobs", [{}], 0);
  } finally { send.mockRestore(); batch.mockRestore(); config.masterToken = previous; }
});

test("tiny and empty chunks have a finite budget even below the byte limit", async () => {
  let pulls = 0;
  let cancelled = false;
  const empty = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await expect(readPgmqRequestBody(request(empty), 100)).rejects.toMatchObject({ status: 413 });
  expect(pulls).toBe(PGMQ_BODY_MAX_CHUNKS + 1);
  expect(cancelled).toBe(true);
  let index = 0;
  const exact = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === PGMQ_BODY_MAX_CHUNKS) { controller.close(); return; }
      controller.enqueue(Uint8Array.of(index === 0 ? 123 : index === 1 ? 125 : 32));
      index++;
    },
  }, { highWaterMark: 0 });
  expect(await readPgmqRequestBody(request(exact), PGMQ_BODY_MAX_CHUNKS)).toEqual({});
});

test("native HTTP send and batch ingress enforce body limits and allow valid streaming JSON", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-native-body-token";
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const batch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1"]);
  const app = new Elysia().use(taskRoutes);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 12 * 1024 * 1024,
    fetch: app.fetch,
  });
  const headers = { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" };
  const url = `http://127.0.0.1:${server.port}/v1/projects/proj_1/tasks/queues/jobs/messages`;
  try {
    for (const [path, limit] of [["", PGMQ_SEND_BODY_BYTES], ["/batch", PGMQ_BATCH_BODY_BYTES]] as const) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(" ".repeat(limit + 1)));
          controller.close();
        },
      });
      const response = await fetch(`${url}${path}`, { method: "POST", headers, body });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        message: "Queue request body could not be accepted", code: "PGMQ_REQUEST_BODY_INVALID",
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    const valid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":'));
        controller.enqueue(new TextEncoder().encode('{"a":1}}'));
        controller.close();
      },
    });
    const response = await fetch(url, { method: "POST", headers, body: valid });
    expect(response.status).toBe(202);
    await response.arrayBuffer();
    expect(send).toHaveBeenLastCalledWith("proj_1", "jobs", { a: 1 }, 0);
    const batchResponse = await fetch(`${url}/batch`, { method: "POST", headers, body: '{"messages":[{}]}' });
    expect(batchResponse.status).toBe(202);
    await batchResponse.arrayBuffer();
    expect(batch).toHaveBeenLastCalledWith("proj_1", "jobs", [{}], 0);
  } finally {
    await server.stop(true);
    send.mockRestore(); batch.mockRestore(); config.masterToken = previous;
  }
}, 30_000);

test("request body helper compiles with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-request-body.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);

test("enqueue authorization precedes body consumption and cancels denied streams", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-preparse-token";
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const batch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1"]);
  const app = new Elysia().use(taskRoutes);
  try {
    for (const path of ["", "/batch"]) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() { pulls++; },
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      }, { highWaterMark: 0 });
      const response = await app.handle(new Request(
        `http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`,
        { method: "POST", body, headers: { "content-type": "application/json" } },
      ));
      expect(response.status).toBe(401);
      expect(pulls).toBe(0);
      expect(cancelled).toBe(true);
    }
    expect(send).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  } finally { send.mockRestore(); batch.mockRestore(); config.masterToken = previous; }
});

test("preparse auth binds the matched project and fails closed without leaking auth errors", async () => {
  const authorize = spyOn(auth, "requireProjectOrAdminAuth");
  const send = spyOn(pgmqService, "send").mockResolvedValue("1");
  const app = new Elysia().use(taskRoutes);
  const call = (body: BodyInit) => app.handle(new Request(
    "http://localhost/v1/projects/target_project/tasks/queues/jobs/messages",
    { method: "POST", body, headers: { "content-type": "application/json" } },
  ));
  try {
    for (const failure of [
      { status: 403, body: { error: "Project service role or admin privileges required" } },
      { status: 401, body: { error: "Invalid token" } },
    ]) {
      authorize.mockResolvedValue(failure);
      const response = await call("{");
      expect(response.status).toBe(failure.status);
      expect(await response.json()).toEqual(failure.body);
      expect(authorize).toHaveBeenLastCalledWith(expect.any(Request), "target_project");
    }
    authorize.mockRejectedValue(new Error("private auth database detail"));
    const unavailable = await call("{");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Queue authorization could not be confirmed" });
    expect(send).not.toHaveBeenCalled();
    authorize.mockReset();
    authorize.mockResolvedValueOnce(undefined);
    authorize.mockResolvedValueOnce({ status: 403, body: { error: "Revoked during body read" } });
    const revoked = await call('{"message":{}}');
    expect(revoked.status).toBe(403);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  } finally { authorize.mockRestore(); send.mockRestore(); }
});
