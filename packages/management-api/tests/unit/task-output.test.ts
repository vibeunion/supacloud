import { test } from "node:test";
import assert from "node:assert/strict";
import { taskOutputCursor, taskOutputQuery, taskOutputScope, parseTaskOutput, isTaskOutputReadRequest,
  resolveTaskOutputInvoker, readTaskOutputBody, TaskOutputError } from "../../src/utils/task-output";
import { createTaskOutputHandlers, taskOutputResponse } from "../../src/routes/task-output-handler";
const id = "11111111-1111-1111-1111-111111111111", user = "22222222-2222-2222-2222-222222222222";
const url = `https://api.example/v1/projects/demo/tasks/${id}/events`;
const input = { event_id: id, attempt: 1, type: "output.delta", payload: { text: "hello" } };
const request = (body: unknown = input) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("bigint cursors remain lossless, canonical and bounded", () => {
  assert.equal(taskOutputCursor("9007199254740993"), "9007199254740993");
  assert.equal(taskOutputCursor("9223372036854775807"), "9223372036854775807");
  for (const value of [1, -1, "-1", "01", "+1", "1e2", "1.0", "", "9223372036854775808"]) assert.throws(() => taskOutputCursor(value), TaskOutputError);
});
test("query parser rejects ambiguous or oversized pages", () => {
  assert.deepEqual(taskOutputQuery(new URL(url)), { after: "0", limit: 50 });
  for (const query of ["limit=0", "limit=101", "limit=01", "limit=1&limit=2", "after=1&after=2"]) assert.throws(() => taskOutputQuery(new URL(`${url}?${query}`)));
});
test("scope is validated without coercion", () => {
  assert.deepEqual(taskOutputScope("demo", id), { projectRef: "demo", taskId: id });
  assert.throws(() => taskOutputScope("../secret", id));
  assert.throws(() => taskOutputScope("demo", "../queues"));
});
test("ordinary JWTs only reach the exact GET events resource", () => {
  assert.ok(isTaskOutputReadRequest(new Request(url)));
  for (const candidate of [new Request(url, { method: "POST" }), new Request(url.replace("/events", "")), new Request(url + "/secret"), new Request(url.replace(id, "queues"))]) assert.equal(isTaskOutputReadRequest(candidate), false);
});
test("verified scoped authenticated identity is accepted", async () => {
  const req = new Request(url, { headers: { authorization: "Bearer signed-token" } });
  assert.equal(await resolveTaskOutputInvoker(req, async (token, ref) => {
    assert.equal(token, "signed-token"); assert.equal(ref, "demo"); return { ref, role: "authenticated", sub: user };
  }, false, "demo"), user);
});
test("anon, other project, missing subject and invalid signature fail closed", async () => {
  const req = new Request(url, { headers: { authorization: "Bearer token" } });
  for (const jwt of [null, { ref: "other", role: "authenticated", sub: user }, { ref: "demo", role: "anon", sub: user }, { ref: "demo", role: "authenticated" }, { ref: "demo", role: "service_role", sub: user }]) {
    assert.equal(await resolveTaskOutputInvoker(req, async () => jwt, false), null);
  }
});
test("delegation and writes cannot take the user-JWT shortcut", async () => {
  const verify = async () => { throw new Error("must not verify on disallowed surface"); };
  assert.equal(await resolveTaskOutputInvoker(new Request(url), verify, true), null);
  assert.equal(await resolveTaskOutputInvoker(request(), verify, false), null);
  assert.equal(await resolveTaskOutputInvoker(new Request(url), verify, false, "other"), null);
});
test("output parser freezes the JSON snapshot and prohibits lifecycle spoofing", () => {
  const original = structuredClone(input), result = parseTaskOutput(original);
  original.payload.text = "changed"; assert.equal(result.payload.text, "hello");
  for (const candidate of [{ ...input, attempt: 0 }, { ...input, attempt: "1" }, { ...input, type: "task.succeeded" }, { ...input, event_id: "invalid" }, { ...input, payload: [] }, { ...input, payload: { toJSON: () => null } }]) assert.throws(() => parseTaskOutput(candidate));
});
test("UTF-8 output sizes and request bodies are bounded", async () => {
  assert.throws(() => parseTaskOutput({ ...input, payload: { text: "中".repeat(6000) } }));
  assert.equal((await readTaskOutputBody(request())).payload.text, "hello");
  await assert.rejects(readTaskOutputBody(request({ ...input, payload: { text: "x".repeat(22000) } })), TaskOutputError);
  await assert.rejects(readTaskOutputBody(new Request(url, { method: "POST", body: "{}" })), TaskOutputError);
  await assert.rejects(readTaskOutputBody(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })), TaskOutputError);
});
function handlers(overrides: Record<string, unknown> = {}) {
  return createTaskOutputHandlers({
    authorizeRead: async () => ({ invokerUserId: user }), authorizeWrite: async () => null,
    read: async (_ref, _id, _after, _limit, owner) => { assert.equal(owner, user); return { replay_available: true, events: [] }; },
    append: async (_ref, _id, event) => ({ ...event, sequence: "1" }), ...overrides,
  });
}
test("owned reads pass the verified subject, never a caller's owner parameter", async () => {
  const response = await handlers().read(new Request(`${url}?invoker_user_id=other`), { ref: "demo", taskId: id });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
});
test("authentication precedes body parsing and side effects", async () => {
  let called = false;
  const response = await handlers({ authorizeWrite: async () => taskOutputResponse({ error: "denied" }, 403), append: async () => { called = true; } })
    .append(new Request(url, { method: "POST", body: "not json" }), { ref: "demo", taskId: id });
  assert.equal(response.status, 403); assert.equal(called, false);
});
test("invalid pagination cannot query the database", async () => {
  let called = false;
  const response = await handlers({ read: async () => { called = true; } }).read(new Request(`${url}?after=01`), { ref: "demo", taskId: id });
  assert.equal(response.status, 400); assert.equal(called, false);
});
test("retention returns explicit 410, never a silent reset", async () => {
  const response = await handlers({ read: async () => ({ replay_available: false, retained_after: "100" }) }).read(new Request(url), { ref: "demo", taskId: id });
  assert.equal(response.status, 410); assert.equal((await response.json()).code, "TASK_OUTPUT_REPLAY_UNAVAILABLE");
});
test("cross-owner absence and stale attempts have distinct safe errors", async () => {
  const response = await handlers({ read: async () => { throw new TaskOutputError(404, "TASK_OUTPUT_NOT_FOUND", "not found"); } }).read(new Request(url), { ref: "demo", taskId: id });
  assert.equal(response.status, 404);
  const append = await handlers({ append: async () => { throw new TaskOutputError(409, "TASK_OUTPUT_STALE_ATTEMPT", "stale"); } }).append(request(), { ref: "demo", taskId: id });
  assert.equal(append.status, 409);
});
test("missing migration and database failure return 503 without leaking details", async () => {
  const response = await handlers({ read: async () => { throw new Error("postgres://secret@internal"); } }).read(new Request(url), { ref: "demo", taskId: id });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("secret"));
});
