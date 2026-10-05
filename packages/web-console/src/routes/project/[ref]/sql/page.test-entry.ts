import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, unmount, flushSync } from "svelte";
import Harness from "./page.test-harness.svelte";
import { page, setApiHandler, setNotebookHandler, notifications } from "./page.test-fixture.svelte";

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

function buttonTitle(title: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(item => item.title === title);
  if (!button) throw new Error(`Missing button: ${title}`);
  return button;
}

function notebookTitle(value: string): void {
  const input = document.querySelector('input[aria-label="笔记本名称"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing notebook title");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request body");
  return Object.fromEntries(Object.entries(value));
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
  const submitted = record(calls[0]?.body);
  if (submitted.sql !== "select 'a'" || typeof submitted.query_id !== "string") {
    throw new Error("Invalid SQL request body");
  }
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

// Notebook operations retain their originating tab, revision and project.
page.params.ref = "notebooks";
const id = "ab000000-0000-4000-8000-000000000000";
const savedNotebook = { id, project_ref: "notebooks", name: "Analysis", content: "select 10", revision: 1, content_bytes: 9 };
const notebookCalls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
const delayedSave = Promise.withResolvers<Response>();
let conflict = true;
setNotebookHandler(async (url, options) => {
  const method = options.method ?? "GET";
  if (method !== "GET") {
    notebookCalls.push({ url, method, body: record(JSON.parse(String(options.body))) });
    if (method === "POST") return delayedSave.promise;
    if (method === "PUT" && conflict) return Response.json({ code: "NOTEBOOK_REVISION_CONFLICT" }, { status: 409 });
    if (method === "DELETE") return Response.json({ deleted: true });
    return Response.json({ ...savedNotebook, content: "select 11", revision: 2 });
  }
  return Response.json(url.endsWith(id)
    ? savedNotebook : { project_ref: "notebooks", items: [savedNotebook], next_offset: null });
});
const notebookComponent = mount(Harness, { target: document.body });
try {
  await eventually(() => assert.equal(editor().value, ""));
  edit("select 10");
  notebookTitle("Analysis");
  command("保存").click();
  await eventually(() => assert.equal(notebookCalls.length, 1));
  buttonTitle("SqlEditor.new_query").click();
  edit("select 20");
  notebookTitle("Other");
  delayedSave.resolve(Response.json(savedNotebook, { status: 201 }));
  await eventually(() => assert.equal(command("保存").disabled, false));
  assert.equal(editor().value, "select 20");
  const tabs = [...document.querySelectorAll("button")].filter(item => item.textContent?.includes("SqlEditor.untitled_query"));
  tabs[0]!.click();
  await eventually(() => assert.equal(editor().value, "select 10"));
  edit("select 11");
  command("保存").click();
  await eventually(() => assert.ok(notifications.some(message => message.includes("本地 SQL 已保留"))));
  assert.equal(editor().value, "select 11");
  assert.equal(notebookCalls[1]?.method, "PUT");
  assert.equal(notebookCalls[1]?.body.expected_revision, 1);
  assert.ok(notebookCalls[1]?.url.endsWith(id));
} finally {
  await unmount(notebookComponent);
}
const restored = mount(Harness, { target: document.body });
try {
  await eventually(() => assert.equal(editor().value, "select 11"));
  conflict = false;
  command("保存").click();
  await eventually(() => assert.equal(notebookCalls.length, 3));
  assert.equal(notebookCalls[2]?.method, "PUT");
  assert.equal(notebookCalls[2]?.body.expected_revision, 1);
  await eventually(() => assert.equal(command("保存").disabled, false));
  const selector = document.querySelector('select[aria-label="选择 SQL 笔记本"]');
  if (!(selector instanceof HTMLSelectElement)) throw new Error("Missing notebook picker");
  selector.value = id;
  selector.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  command("加载").click();
  await eventually(() => assert.equal(editor().value, "select 10"));
  buttonTitle("删除当前 SQL 笔记本").click();
  await eventually(() => assert.ok(document.querySelector('[role="alertdialog"]'), "Notebook delete dialog missing"));
  command("确认删除").click();
  await eventually(() => assert.equal(notebookCalls[3]?.method, "DELETE"));
  assert.equal(notebookCalls[3]?.body.expected_revision, 1);
  await eventually(() => assert.equal(document.querySelector('[role="alertdialog"]'), null));
  assert.equal(editor().value, "select 10");

  const explorerCalls: string[] = [];
  setApiHandler(async url => {
    explorerCalls.push(url);
    return Response.json({ data: [{ table_schema: "public", table_name: 'quoted"table' }], total: 1 });
  });
  buttonTitle("数据库目录").click();
  await eventually(() => assert.ok(document.querySelector('aside')?.textContent?.includes('quoted"table'), "Explorer table missing"));
  command('quoted"table').click();
  await eventually(() => assert.equal(editor().value, 'SELECT * FROM "public"."quoted""table" LIMIT 100;'));
  assert.equal(explorerCalls.length, 1);
  assert.ok(explorerCalls[0]?.includes("/notebooks/database/tables?"));
  assert.equal(explorerCalls.some(url => url.endsWith("/sql")), false);

  const late = Promise.withResolvers<Response>();
  setNotebookHandler(async (url, options) => options.method === "POST" ? late.promise
    : Response.json({ project_ref: url.split("/")[3], items: [], next_offset: null }));
  notebookTitle("Late");
  command("保存").click();
  page.params.ref = "after-notebooks";
  await eventually(() => assert.equal(editor().value, ""));
  const notificationCount = notifications.length;
  late.resolve(Response.json({ ...savedNotebook, name: "Late" }, { status: 201 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(editor().value, "");
  assert.equal(notifications.length, notificationCount);
} finally {
  await unmount(restored);
}
