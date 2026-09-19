import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskEventClient, TaskEventError, type TaskOutputEvent } from "./task-events";
const id = "11111111-1111-1111-1111-111111111111";
const eventId = "22222222-2222-2222-2222-222222222222";
function event(sequence = "1", attempt = 1): TaskOutputEvent {
  return { schema_version: 1, project_ref: "demo", task_id: id, event_id: eventId, sequence, attempt,
    type: "output.delta", payload: { text: `attempt ${attempt}` }, created_at: "2026-09-19T00:00:00Z" };
}
function page(events: TaskOutputEvent[] = [], extra: Record<string, unknown> = {}) {
  const next = events.at(-1)?.sequence ?? "0";
  return { schema_version: 1, project_ref: "demo", task_id: id, enabled: true, task_status: "running", attempt: 1,
    events, next_cursor: next, last_sequence: next, retained_after: "0", has_more: false, replay_available: true, ...extra };
}
function client(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createTaskEventClient({ baseUrl: "https://api.example", projectRef: "demo", getHeaders: () => ({ authorization: "Bearer current" }), fetch });
}
test("list preserves bigint cursors and credentials stay out of URLs", async () => {
  const sdk = client(async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get("after"), "9007199254740993");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer current");
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.ok(!String(input).includes("Bearer"));
    return Response.json(page([event("9007199254740994")]));
  });
  assert.equal((await sdk.list(id, { after: "9007199254740993" })).next_cursor, "9007199254740994");
});
test("credentials refresh for each request", async () => {
  let token = 0;
  const sdk = createTaskEventClient({ baseUrl: "https://api.example", projectRef: "demo", getHeaders: () => ({ authorization: `Bearer ${++token}` }), fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`); return Response.json(page());
  } });
  await sdk.list(id); await sdk.list(id); assert.equal(token, 2);
});
test("invalid task IDs, unsafe cursors and limits never reach fetch", async () => {
  let calls = 0; const sdk = client(async () => { calls++; return Response.json(page()); });
  await assert.rejects(sdk.list("../other")); await assert.rejects(sdk.list(id, { after: "01" }));
  await assert.rejects(sdk.list(id, { limit: 101 })); assert.equal(calls, 0);
});
test("cross-project responses are rejected", async () => {
  await assert.rejects(client(async () => Response.json(page([event()], { project_ref: "other" }))).list(id), TaskEventError);
});
test("skipped, duplicate, unordered or forged cursors cannot advance recovery", async () => {
  for (const value of [page([event("2")]), page([event(), event()]), page([event()], { next_cursor: "10" }), page([], { has_more: true, last_sequence: "2" })]) {
    await assert.rejects(client(async () => Response.json(value)).list(id));
  }
});
test("event schema and version are validated before yielding", async () => {
  for (const changed of [{ schema_version: 2 }, { attempt: -1 }, { event_id: "bad" }, { type: "internal.auth" }, { payload: [] }, { sequence: 1 }]) {
    await assert.rejects(client(async () => Response.json(page([{ ...event(), ...changed } as TaskOutputEvent]))).list(id));
  }
});
test("retention errors expose the watermark without silently restarting", async () => {
  let calls = 0;
  const sdk = client(async () => { calls++; return Response.json({ code: "TASK_OUTPUT_REPLAY_UNAVAILABLE", retained_after: "10" }, { status: 410 }); });
  await assert.rejects(sdk.watch(id, { pollIntervalMs: 10 }).next(), (error: unknown) => error instanceof TaskEventError && error.status === 410 && error.details.retained_after === "10");
  assert.equal(calls, 1);
});
test("cursor checkpoints happen only after consumer processing", async () => {
  const saved: string[] = [];
  const sdk = client(async () => Response.json(page([event()], { task_status: "succeeded" })));
  const iterator = sdk.watch(id, { onCursor: (value) => { saved.push(value); } });
  assert.equal((await iterator.next()).value?.sequence, "1"); assert.deepEqual(saved, []);
  assert.equal((await iterator.next()).done, true); assert.deepEqual(saved, ["1"]);
});
test("consumer stops and errors do not checkpoint unprocessed events", async () => {
  let checkpoints = 0, cleanup = 0;
  const sdk = client(async () => Response.json(page([event()])));
  const iterator = sdk.watch(id, { onCursor: () => { checkpoints++; }, subscribe: () => () => { cleanup++; } });
  await iterator.next(); await iterator.return(); assert.equal(checkpoints, 0); assert.equal(cleanup, 1);
});
test("paginated replay drains before stopping on terminal snapshot", async () => {
  const cursors: string[] = [];
  const sdk = client(async (input) => {
    const after = new URL(String(input)).searchParams.get("after")!; cursors.push(after);
    return Response.json(after === "0" ? page([event("1")], { task_status: "succeeded", last_sequence: "2", has_more: true }) : page([event("2", 2)], { task_status: "succeeded", attempt: 2 }));
  });
  const output: TaskOutputEvent[] = [];
  for await (const item of sdk.watch(id, { limit: 1 })) output.push(item);
  assert.deepEqual(output.map((item) => item.attempt), [1, 2]); assert.deepEqual(cursors, ["0", "1"]);
});
test("missing final Realtime notification is recovered by polling", async () => {
  let calls = 0, cleanup = 0;
  const sdk = client(async () => Response.json(++calls === 1 ? page() : page([event()], { task_status: "succeeded" })));
  const values: string[] = [];
  for await (const item of sdk.watch(id, { pollIntervalMs: 10, subscribe: () => () => { cleanup++; } })) values.push(item.sequence);
  assert.deepEqual(values, ["1"]); assert.equal(calls, 2); assert.equal(cleanup, 1);
});
test("Realtime wakeups carry no recovery cursor and coalesce", async () => {
  let calls = 0;
  const sdk = client(async (input) => {
    assert.equal(new URL(String(input)).searchParams.get("after"), "0");
    return Response.json(++calls === 1 ? page() : page([event()], { task_status: "succeeded" }));
  });
  for await (const _ of sdk.watch(id, { subscribe: (wake) => { wake(); wake(); wake(); return () => {}; } })) {}
  assert.equal(calls, 2);
});
test("transient reads retry but authorization failures do not", async () => {
  let calls = 0;
  const sdk = client(async () => ++calls === 1 ? Response.json({ code: "TASK_OUTPUT_UNAVAILABLE" }, { status: 503 }) : Response.json(page([], { task_status: "succeeded" })));
  assert.equal((await sdk.watch(id, { pollIntervalMs: 10 }).next()).done, true); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(client(async () => { calls++; return Response.json({ code: "denied" }, { status: 403 }); }).watch(id).next());
  assert.equal(calls, 1);
});
test("aborting an observer releases its subscription without cancelling execution", async () => {
  const controller = new AbortController(); let cleanup = 0;
  const sdk = client(async (_input, init) => {
    assert.equal(init?.method, "GET");
    queueMicrotask(() => controller.abort()); return Response.json(page());
  });
  await assert.rejects(sdk.watch(id, { signal: controller.signal, subscribe: () => () => { cleanup++; } }).next());
  assert.equal(cleanup, 1);
});
test("aborted credential resolution does not hang or perform a request", async () => {
  const controller = new AbortController(); let calls = 0;
  const sdk = createTaskEventClient({ baseUrl: "https://api.example", projectRef: "demo", getHeaders: () => new Promise(() => {}), fetch: async () => { calls++; return Response.json(page()); } });
  const work = sdk.list(id, { signal: controller.signal }); controller.abort(); await assert.rejects(work); assert.equal(calls, 0);
});
test("oversized responses are bounded before JSON parsing", async () => {
  await assert.rejects(client(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))).list(id), (error: unknown) => error instanceof TaskEventError && error.code === "TASK_OUTPUT_RESPONSE_TOO_LARGE");
});
test("append uses a stable event ID and never blindly retries uncertain writes", async () => {
  let calls = 0;
  const sdk = client(async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.event_id, eventId); throw new Error("connection lost"); });
  await assert.rejects(sdk.append(id, { attempt: 1, event_id: eventId, type: "output.delta", payload: { text: "hello" } }));
  assert.equal(calls, 1);
});
test("append validates the returned attempt and event identity", async () => {
  const sdk = client(async () => Response.json(event("1", 2)));
  await assert.rejects(sdk.append(id, { attempt: 1, event_id: eventId, type: "output.delta", payload: {} }));
});
