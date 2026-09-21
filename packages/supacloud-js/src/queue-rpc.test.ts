import { expect, test } from "bun:test";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  createSupaCloudClient, SupaCloudQueueError,
  type SupaCloudQueueJson, type SupaCloudQueueReceiveOptions,
} from "./index";
import { queueJsonSnapshot, queueMessage, queueMessageId } from "./queue-rpc";

function harness(handler: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  let tokenReads = 0;
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request);
  }, { preconnect: globalThis.fetch.preconnect });
  const supabase = createClient("https://project.example.com", "synthetic-anon-key", {
    global: { fetch: transport },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const client = createSupaCloudClient({
    supabase, managementApiUrl: "https://management.example.com", projectRef: "proj_1",
    getAccessToken: () => { tokenReads++; throw new Error("Unexpected Management token lookup"); },
  });
  return { client, queue: client.queue("jobs"), calls, tokenReads: () => tokenReads };
}
function row(id: unknown = 123, message: unknown = { job: "send" }) {
  return {
    msg_id: id, read_ct: 1, message,
    enqueued_at: "2026-09-10T00:00:00Z", vt: "2026-09-10T00:00:30Z",
  };
}
async function rejected(work: Promise<unknown>): Promise<SupaCloudQueueError> {
  try { await work; } catch (error) {
    if (error instanceof SupaCloudQueueError) return error;
    throw error;
  }
  throw new Error("Expected queue contract rejection");
}

test("IDs use canonical positive int64 decimal strings without coercion or precision loss", () => {
  for (const id of [1, Number.MAX_SAFE_INTEGER, "1", "9007199254740992", "9223372036854775807"]) {
    expect(queueMessageId(id)).toBe(String(id));
  }
  for (const id of [
    0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined, true,
    "", " 1", "1 ", "+1", "01", "1.0", "1e2", "0x10", "9223372036854775808",
    "1/../../other", {}, [], [1], 1n,
  ]) expect(() => queueMessageId(id)).toThrow(SupaCloudQueueError);
});

test("official SDK RPCs preserve exact IDs, JSON values and explicit false receipts", async () => {
  const bodies: unknown[] = [];
  const { queue, tokenReads } = harness(async request => {
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-profile")).toBe("pgmq_public");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-anon-key");
    bodies.push(await request.json());
    const operation = new URL(request.url).pathname.split("/").pop();
    return Response.json(operation === "send" ? ["9223372036854775807"]
      : operation === "send_batch" ? [123, "9007199254740992"]
      : operation === "read" || operation === "pop" ? [row("9007199254740992", [null, true, "text"])]
      : false);
  });
  expect((await queue.send(null)).msg_id).toBe("9223372036854775807");
  expect((await queue.sendBatch([false, { count: 1 }])).map(message => message.msg_id)).toEqual(["123", "9007199254740992"]);
  expect((await queue.read())[0]?.payload).toEqual([null, true, "text"]);
  expect((await queue.receive())?.msg_id).toBe("9007199254740992");
  expect((await queue.pop())?.status).toBe("deleted");
  expect((await queue.archive("9223372036854775807")).success).toBe(false);
  expect((await queue.delete(123)).msg_id).toBe("123");
  expect((await queue.ack(123)).status).toBe("archived");
  expect((await queue.fail(123)).success).toBe(false);
  expect(bodies[5]).toEqual({ queue_name: "jobs", message_id: "9223372036854775807" });
  expect(tokenReads()).toBe(0);
});

test("send rejects missing, extra, rounded or fabricated IDs as uncertain writes", async () => {
  for (const value of [null, 123, {}, [], [0], [1, 2], [true], [{ send: 1 }], [9007199254740992]]) {
    const { queue, calls } = harness(() => Response.json(value));
    expect((await rejected(queue.send({ job: 1 }))).mutationMayHaveApplied).toBe(true);
    expect(calls).toHaveLength(1);
  }
});

test("batch receipts must contain exactly one distinct valid ID per captured message", async () => {
  for (const value of [null, [], [1], [1, 1], [1, 0], [1, 2, 3], ["01", "2"], [{ send_batch: 1 }, 2]]) {
    const { queue, calls } = harness(() => Response.json(value));
    expect((await rejected(queue.sendBatch([{ a: 1 }, { b: 2 }]))).mutationMayHaveApplied).toBe(true);
    expect(calls).toHaveLength(1);
  }
});

test("archive and delete reject truthy non-booleans without retrying", async () => {
  for (const value of ["false", 1, {}, [false], [true], null]) {
    const { queue, calls } = harness(() => Response.json(value));
    expect((await rejected(queue.archive(1))).mutationMayHaveApplied).toBe(true);
    expect((await rejected(queue.delete(1))).mutationMayHaveApplied).toBe(true);
    expect(calls).toHaveLength(2);
  }
});

test("only actual empty row arrays mean no available messages", async () => {
  const empty = harness(() => Response.json([]));
  expect(await empty.queue.read()).toEqual([]);
  expect(await empty.queue.receive()).toBeNull();
  expect(await empty.queue.pop()).toBeNull();
  for (const value of [null, {}, 1, [null], [[]], [row(), row()], [row(0)], [{ ...row(), message: undefined }],
    [{ ...row(), read_ct: "1" }], [{ ...row(), vt: "later" }],
    [{ ...row(), queue_name: "foreign" }], [{ ...row(), id: "124" }],
  ]) {
    const { queue } = harness(() => Response.json(value));
    expect((await rejected(queue.read())).mutationMayHaveApplied).toBe(true);
    expect((await rejected(queue.pop())).mutationMayHaveApplied).toBe(true);
  }
});

test("local ID, queue name and numeric input failures never dispatch", async () => {
  const { client, queue, calls, tokenReads } = harness(() => { throw new Error("Must not fetch"); });
  for (const name of ["", " Jobs", "jobs/other", "supacloud_internal_jobs"]) {
    expect(() => client.queue(name)).toThrow(SupaCloudQueueError);
  }
  for (const id of ["", "0", "1.2", " 12", "12/../other", Number.MAX_SAFE_INTEGER + 1]) {
    for (const operation of [() => queue.archive(id), () => queue.delete(id), () => queue.release(id),
      () => queue.get(id as string), () => queue.retry(id as string)]) {
      expect((await rejected(operation())).mutationMayHaveApplied).toBe(false);
    }
  }
  for (const input of [
    { n: 0 }, { n: 1.2 }, { count: NaN }, { n: null }, { n: 2, count: 3 },
    { sleepSeconds: Infinity }, { sleepSeconds: -1 }, { sleepSeconds: 1, sleep_seconds: 2 },
    { delayMs: -1 }, { sleepSeconds: null },
  ]) {
    const untyped: unknown = input;
    expect((await rejected(queue.read(untyped as SupaCloudQueueReceiveOptions))).mutationMayHaveApplied).toBe(false);
  }
  expect((await rejected(queue.receive({ count: 2 }))).mutationMayHaveApplied).toBe(false);
  expect(calls).toHaveLength(0);
  expect(tokenReads()).toBe(0);
});

test("payload snapshots reject non-JSON values and do not execute getters", async () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { getters++; return "secret"; } });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const { queue, calls } = harness(() => { throw new Error("Must not fetch"); });
  for (const input of [NaN, Infinity, 1n, { a: undefined }, { a: () => 1 }, new Date(), new Map(), cycle, accessor, new Array(2)]) {
    expect((await rejected(queue.send(input as SupaCloudQueueJson))).mutationMayHaveApplied).toBe(false);
  }
  expect(getters).toBe(0);
  expect(calls).toHaveLength(0);
  const source: unknown = JSON.parse('{"__proto__":{"polluted":true},"nested":[1,null]}');
  const snapshot = queueJsonSnapshot(source);
  expect(Object.hasOwn(snapshot ?? {}, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
});

test("send receipts stay bound to messages captured before asynchronous transport", async () => {
  let finish: ((response: Response) => void) | undefined;
  let submitted: unknown;
  const { queue } = harness(async request => {
    submitted = await request.json();
    return new Promise(resolve => { finish = resolve; });
  });
  const messages = [{ nested: { name: "original" } }, { nested: { name: "second" } }];
  const work = queue.sendBatch(messages, { delayMs: 1500 });
  messages[0]!.nested.name = "changed";
  messages.pop();
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  finish(Response.json([1, 2]));
  const receipts = await work;
  expect(receipts[0]?.payload).toEqual({ nested: { name: "original" } });
  expect(receipts[1]?.payload).toEqual({ nested: { name: "second" } });
  expect(submitted).toEqual({
    queue_name: "jobs", messages: [{ nested: { name: "original" } }, { nested: { name: "second" } }], sleep_seconds: 1,
  });
});

test("Management message decoder binds IDs and preserves JSON payloads without unknown fields", () => {
  expect(queueMessage({ id: "123", msg_id: 123, message: null, raw: "hidden" })).toEqual({
    id: "123", msg_id: "123", message: null, payload: null,
  });
  expect(() => queueMessage({ ...row(), payload: { changed: true } })).toThrow();
  expect(() => queueMessage(row(), { messageId: "124" })).toThrow();
  expect(() => queueMessage({ ...row(), queue_name: "other" }, { queueName: "jobs" })).toThrow();
});

test("Management release never reports a mismatched receipt as a confirmed write", async () => {
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests++;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/v1/projects/proj_1/tasks/queues/jobs/messages/123/release");
      expect(await request.json()).toEqual({ sleep_seconds: 5 });
      return Response.json({ ...row(124), id: "124", queue_name: "jobs" });
    },
  });
  try {
    const supabase = createClient("https://project.example.com", "synthetic-anon-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const queue = createSupaCloudClient({
      supabase, managementApiUrl: upstream.url.origin, projectRef: "proj_1", getAccessToken: () => "management-token",
    }).queue("jobs");
    const error = await rejected(queue.release(123, { sleepSeconds: 5 }));
    expect(error.mutationMayHaveApplied).toBe(true);
    expect(requests).toBe(1);
  } finally { await upstream.stop(true); }
});

test("native HTTP upstream failure never retries a mutating RPC", async () => {
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requests++;
      return Response.json({ message: "secret database details", code: "private-code" }, {
        status: 503, headers: { "retry-after": "0" },
      });
    },
  });
  try {
    const supabase = createClient(upstream.url.origin, "synthetic-anon-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const queue = createSupaCloudClient({
      supabase, managementApiUrl: "https://management.example.com", projectRef: "proj_1",
    }).queue("jobs");
    for (const work of [() => queue.send({}), () => queue.read(), () => queue.pop(), () => queue.archive(1), () => queue.delete(1)]) {
      const error = await rejected(work());
      expect(error.code).toBe("QUEUE_RPC_FAILED");
      expect(error.message).not.toContain("secret");
      expect(error.mutationMayHaveApplied).toBe(true);
    }
    expect(requests).toBe(5);
  } finally { await upstream.stop(true); }
});

test("focused queue contract types compile strictly with full library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit",
      "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--skipLibCheck", "false",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext",
      "--lib", "ESNext,DOM,DOM.Iterable", "--types", "node", join(import.meta.dir, "../test/queue-rpc-types.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
