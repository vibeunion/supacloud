import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, unmount, flushSync } from "svelte";
import Harness from "./page.test-harness.svelte";
import { page, setApiHandler, notifications } from "./page.test-fixture.svelte";

const assert: { equal: typeof strictEqual; deepEqual: typeof deepStrictEqual; ok: typeof ok } =
  { equal: strictEqual, deepEqual: deepStrictEqual, ok };

async function eventually(assertion: () => void): Promise<void> {
  const end = performance.now() + 4000;
  let lastError: unknown;
  while (performance.now() < end) {
    try { assertion(); return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw lastError;
}

function editor(): HTMLTextAreaElement {
  const input = document.querySelector("textarea");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing SQL editor");
  return input;
}

function edit(sql: string): void {
  editor().value = sql;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function command(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim().startsWith(label));
  if (!button) throw new Error(`Missing SQL command: ${label}`);
  return button;
}

localStorage.setItem("supacloud_a_sql_tabs", JSON.stringify([
  { id: "shared-id", name: "Draft A", sql: "select 'a'", results: [{ leaked: "old-secret" }] },
]));
localStorage.setItem("supacloud_b_sql_tabs", JSON.stringify([
  { id: "shared-id", name: "Draft B", sql: "select 'b'" },
]));

const pendingQuery = Promise.withResolvers<Response>();
const pendingCancellation = Promise.withResolvers<Response>();
const calls: Array<{ url: string; body: unknown }> = [];
setApiHandler(async (url, options) => {
  calls.push({ url, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
  if (url.endsWith("/cancel")) return pendingCancellation.promise;
  if (url.includes("/a/")) return pendingQuery.promise;
  return Response.json({ rows: [null] });
});
const target = document.body.appendChild(document.createElement("div"));
const component = mount(Harness, { target });
try {
  await eventually(() => assert.equal(editor().value, "select 'a'"));
  assert.equal(document.body.textContent?.includes("old-secret"), false);
  command("SqlEditor.run_query").click();
  edit("edited after send");
  await eventually(() => assert.equal(calls.length, 1));
  assert.ok(calls[0]?.url.includes("/a/database/sql"));
  const submitted = calls[0]?.body;
  assert.ok(submitted && typeof submitted === "object" && "sql" in submitted);
  assert.equal(submitted.sql, "select 'a'");
  assert.ok("query_id" in submitted && typeof submitted.query_id === "string");
  const queryId = submitted.query_id;
  command("SqlEditor.cancel_query").click();
  await eventually(() => assert.equal(calls.length, 2));
  assert.ok(calls[1]?.url.includes(`/a/database/sql/${queryId}/cancel`));

  page.params.ref = "b";
  await eventually(() => assert.equal(editor().value, "select 'b'"));
  assert.equal(command("SqlEditor.run_query").disabled, false);
  pendingCancellation.resolve(Response.json({ query_id: queryId, cancelled: true, durationMs: 1 }));
  pendingQuery.resolve(Response.json({ rows: [{ leaked: "late-secret" }] }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(document.body.textContent?.includes("late-secret"), false);
  assert.deepEqual(notifications, []);
  assert.deepEqual(JSON.parse(localStorage.getItem("supacloud_a_sql_tabs") ?? "null"), [
    { id: "shared-id", name: "Draft A", sql: "edited after send" },
  ]);
  command("SqlEditor.run_query").click();
  await eventually(() => assert.ok(document.body.textContent?.includes("Invalid SQL response")));
  assert.equal(calls.length, 3);
  await eventually(() => assert.equal(command("SqlEditor.run_query").disabled, false));

  // Wait past TanStack's first retry delay; malformed receipts must not replay SQL.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(localStorage.getItem("supacloud_b_sql_tabs") ?? "null"), [
    { id: "shared-id", name: "Draft B", sql: "select 'b'" },
  ]);
  localStorage.setItem("supacloud_invalid_sql_tabs", '[{"id":3,"name":null}]');
  page.params.ref = "invalid";
  await eventually(() => assert.equal(editor().value, ""));
  assert.equal(command("SqlEditor.run_query").disabled, true);
  delete page.params.ref;
  await eventually(() => assert.equal(document.querySelector("textarea"), null));
} finally {
  await unmount(component);
  target.remove();
}

const storagePrototype = Object.getPrototypeOf(localStorage);
const getDescriptor = Object.getOwnPropertyDescriptor(storagePrototype, "getItem");
const setDescriptor = Object.getOwnPropertyDescriptor(storagePrototype, "setItem");
if (!getDescriptor || !setDescriptor) throw new Error("Missing storage fixture descriptors");
Object.defineProperty(storagePrototype, "getItem", { configurable: true, value() { throw new Error("Storage disabled"); } });
Object.defineProperty(storagePrototype, "setItem", { configurable: true, value() { throw new Error("Storage disabled"); } });
page.params.ref = "offline-storage";
const unavailable = mount(Harness, { target: document.body });
try {
  await eventually(() => assert.equal(editor().value, ""));
  edit("select 1");
  await eventually(() => assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("SqlEditor.save_failed")));
  assert.equal(command("SqlEditor.run_query").disabled, false);
} finally {
  await unmount(unavailable);
  Object.defineProperty(storagePrototype, "getItem", getDescriptor);
  Object.defineProperty(storagePrototype, "setItem", setDescriptor);
}
