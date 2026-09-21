import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import TaskPage from "./+page.svelte";
import { notifications, page, setApiHandler, TaskSocket } from "./page.test-fixture.svelte";
import { backgroundSettings, otherTaskId, taskFixture, taskId, taskTime } from "../../../../lib/task-center.test-fixtures";

const assert: { equal: typeof strictEqual; deepEqual: typeof deepStrictEqual; ok: typeof ok } =
  { equal: strictEqual, deepEqual: deepStrictEqual, ok };
Object.assign(globalThis, { WebSocket: TaskSocket });

async function eventually(assertion: () => void) {
  const deadline = performance.now() + 4000;
  let error: unknown;
  do {
    try { assertion(); return; } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw error;
}
function button(label: string): HTMLButtonElement {
  const value = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!value) throw new Error(`Missing task command ${label}`);
  return value;
}
function field(): HTMLInputElement {
  const value = document.querySelector('input[type="number"]');
  if (!(value instanceof HTMLInputElement)) throw new Error("Missing settings input");
  return value;
}
function edit(value: string) {
  const input = field();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function row(id = taskId): HTMLTableRowElement {
  const value = [...document.querySelectorAll("tbody tr")].find(item => item.textContent?.includes(id));
  if (!(value instanceof HTMLTableRowElement)) throw new Error("Missing task row");
  return value;
}
function defaults(url: string): Response {
  const parsed = new URL(url, "http://localhost");
  const ref = parsed.pathname.split("/")[3];
  if (!ref) throw new Error("Missing fixture project");
  if (parsed.pathname.endsWith("/settings/background")) return Response.json(backgroundSettings);
  if (parsed.pathname.endsWith("/tasks")) {
    return Response.json(parsed.searchParams.has("dlq") ? [] : [taskFixture(ref), taskFixture(ref, otherTaskId)]);
  }
  const id = parsed.pathname.split("/").at(-1);
  return Response.json(taskFixture(ref, id));
}
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  page.url = new URL("http://localhost/project/a/tasks");
  notifications.length = 0;
  TaskSocket.instances = [];
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(TaskPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function loaded() {
  await eventually(() => { assert.ok(row()); assert.equal(button("Common.refresh").disabled, false); });
}
async function changeProject(ref: string) {
  page.params.ref = ref;
  await tick();
}

async function boundariesAndSettings() {
  let malformed = true;
  let lists = 0;
  let settingsReads = 0;
  const writes: Array<{ url: string; body: unknown }> = [];
  const pending = Promise.withResolvers<Response>();
  setApiHandler(async (url, options) => {
    if (options.method === "PATCH") {
      const body: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
      writes.push({ url, body });
      return writes.length === 1 ? pending.promise : Response.json({ ...backgroundSettings, concurrency: 25 });
    }
    if (url.includes("settings/background")) settingsReads++;
    else if (url.includes("?")) lists++;
    if (malformed) return Response.json(url.includes("settings/background") ? [] : [taskFixture("wrong")]);
    return defaults(url);
  });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(document.querySelector("tbody"), null);
    button("TaskCenter.background_settings").click();
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, true));
    assert.equal(document.querySelector('input[type="number"]'), null);
    malformed = false;
    await changeProject("b");
    await eventually(() => assert.equal(field().value, "30"));
    edit("26");
    const oldLists = lists;
    button("Common.refresh").click();
    await eventually(() => assert.ok(lists > oldLists));
    await eventually(() => assert.equal(button("Common.refresh").disabled, false));
    assert.equal(field().value, "26");
    assert.equal(settingsReads, 2);
    edit("");
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, true));
    edit("1.5");
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, true));
    edit("26");
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, false));
    button("TaskCenter.save_settings").click();
    button("TaskCenter.save_settings").click();
    await eventually(() => assert.equal(writes.length, 1));
    assert.deepEqual(writes[0], { url: "/v1/projects/b/tasks/settings/background", body: { ...backgroundSettings, concurrency: 26 } });
    assert.ok(field().matches(":disabled"));
    pending.resolve(Response.json({ ...backgroundSettings, concurrency: 27 }));
    await eventually(() => assert.ok(notifications.some(item => item.kind === "error")));
    assert.equal(field().value, "26");
    assert.equal(writes.length, 1);
    assert.equal(notifications.some(item => item.kind === "success"), false);
    edit("25");
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, false));
    button("TaskCenter.save_settings").click();
    await eventually(() => assert.ok(notifications.some(item => item.kind === "success")));
    assert.equal(writes.length, 2);
    assert.equal(button("TaskCenter.save_settings").disabled, true);
  });
}

async function staleProjectReads() {
  const oldList = Promise.withResolvers<Response>();
  const oldSettings = Promise.withResolvers<Response>();
  let aLists = 0;
  let aSettings = 0;
  let cancelledBodies = 0;
  setApiHandler(async (url) => {
    if (url.includes("/a/") && url.includes("settings/background") && ++aSettings === 1) return oldSettings.promise;
    if (url.startsWith("/v1/projects/a/tasks?") && !url.includes("dlq=") && ++aLists === 1) return oldList.promise;
    return defaults(url);
  });
  await mounted(async () => {
    await eventually(() => assert.equal(aLists, 1));
    const oldSocket = TaskSocket.instances[0];
    assert.ok(oldSocket);
    await changeProject("b");
    await loaded();
    await changeProject("a");
    await loaded();
    assert.equal(oldSocket.closed, true);
    oldList.resolve(new Response(new ReadableStream({ cancel() { cancelledBodies++; } })));
    oldSettings.resolve(new Response(new ReadableStream({ cancel() { cancelledBodies++; } })));
    await eventually(() => assert.equal(cancelledBodies, 2));
    button("TaskCenter.background_settings").click();
    await eventually(() => assert.equal(field().value, "30"));
    assert.equal(notifications.length, 0);
  });
}

async function selectionAndMutations() {
  const oldDetail = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  let details = 0;
  let mutations = 0;
  setApiHandler(async (url, options) => {
    if (options.method === "POST") { mutations++; return retry.promise; }
    if (url.endsWith(taskId) && ++details === 1) return oldDetail.promise;
    return defaults(url);
  });
  await mounted(async () => {
    await loaded();
    row().click();
    await eventually(() => assert.equal(details, 1));
    row(otherTaskId).click();
    await eventually(() => assert.ok(button("TaskCenter.retry")));
    oldDetail.resolve(Response.json(taskFixture()));
    await new Promise(resolve => setTimeout(resolve, 20));
    button("TaskCenter.retry").click();
    button("TaskCenter.retry").click();
    await eventually(() => assert.equal(mutations, 1));
    row().click();
    await eventually(() => assert.ok(button("TaskCenter.retry")));
    row(otherTaskId).click();
    await eventually(() => assert.ok(button("TaskCenter.retry")));
    retry.resolve(Response.json({
      ...taskFixture("a", otherTaskId), status: "pending", error: null, completed_at: null, next_run_at: taskTime,
    }));
    await eventually(() => assert.equal(button("TaskCenter.retry").disabled, false));
    assert.equal(notifications.length, 0);
    assert.equal(mutations, 1);
  });
}

async function staleMutationsAndNotifications() {
  const pending = Promise.withResolvers<Response>();
  let writes = 0;
  let listReads = 0;
  setApiHandler(async (url, options) => {
    if (options.method === "POST") { writes++; return pending.promise; }
    if (url.includes("?")) listReads++;
    return defaults(url);
  });
  await mounted(async () => {
    await loaded();
    row().click();
    await eventually(() => assert.ok(button("TaskCenter.retry")));
    button("TaskCenter.retry").click();
    await eventually(() => assert.equal(writes, 1));
    await changeProject("b");
    await loaded();
    await changeProject("a");
    await loaded();
    row().click();
    await eventually(() => assert.ok(button("TaskCenter.retry")));
    pending.resolve(Response.json({ ...taskFixture(), status: "pending", error: null, completed_at: null, next_run_at: taskTime }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(notifications.length, 0);
    assert.equal(button("TaskCenter.retry").disabled, false);
    const socket = TaskSocket.instances.at(-1);
    assert.ok(socket);
    const before = listReads;
    socket.emit(null);
    socket.emit({ type: "task_update", projectRef: "b", taskId, taskType: "queue:work", status: "succeeded", timestamp: taskTime });
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(listReads, before);
    socket.emit({ type: "task_update", projectRef: "a", taskId, taskType: "queue:work", status: "succeeded", timestamp: taskTime });
    assert.ok(row().textContent?.includes("TaskCenter.status_failed"));
    await eventually(() => assert.ok(listReads > before));
    assert.ok(row().textContent?.includes("TaskCenter.status_failed"));
    assert.equal(writes, 1);
  });
}

async function cancellationAndSettingsNavigation() {
  let requested = false;
  let cancellations = 0;
  const settingsWrite = Promise.withResolvers<Response>();
  let settingsWrites = 0;
  setApiHandler(async (url, options) => {
    if (options.method === "PATCH") { settingsWrites++; return settingsWrite.promise; }
    const task = {
      ...taskFixture(), status: "running", completed_at: null,
      cancel_requested_at: requested ? taskTime : null,
    };
    if (url.endsWith("/cancel")) {
      cancellations++;
      if (cancellations === 1) return Response.json({ ...task, project_ref: "b" });
      requested = true;
      return Response.json({ ...task, cancel_requested_at: taskTime });
    }
    if (url.endsWith(taskId)) return Response.json(task);
    return defaults(url);
  });
  await mounted(async () => {
    await loaded();
    row().click();
    await eventually(() => assert.equal(button("TaskCenter.cancel_task").disabled, false));
    assert.equal(button("TaskCenter.retry").disabled, true);
    button("TaskCenter.cancel_task").click();
    await eventually(() => assert.ok(notifications.some(item => item.message === "TaskCenter.cancel_failed")));
    assert.equal(cancellations, 1);
    assert.equal(notifications.some(item => item.kind === "success"), false);
    await eventually(() => assert.equal(button("TaskCenter.cancel_task").disabled, false));
    button("TaskCenter.cancel_task").click();
    await eventually(() => assert.ok(notifications.some(item => item.message === "TaskCenter.cancel_requested")));
    await eventually(() => assert.equal(button("TaskCenter.cancel_task").disabled, true));
    assert.equal(notifications.some(item => item.message === "TaskCenter.cancel_success"), false);
    assert.equal(cancellations, 2);
    button("TaskCenter.background_settings").click();
    await eventually(() => assert.equal(field().value, "30"));
    edit("24");
    await eventually(() => assert.equal(button("TaskCenter.save_settings").disabled, false));
    button("TaskCenter.save_settings").click();
    await eventually(() => assert.equal(settingsWrites, 1));
    const before = notifications.length;
    await changeProject("b");
    await eventually(() => assert.equal(field().value, "30"));
    await changeProject("a");
    await eventually(() => assert.equal(field().value, "30"));
    edit("23");
    settingsWrite.resolve(Response.json({ ...backgroundSettings, concurrency: 24 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(field().value, "23");
    assert.equal(notifications.length, before);
    assert.equal(settingsWrites, 1);
    assert.equal(field().matches(":disabled"), false);
  });
}

async function invalidationDuringDetailRead() {
  const pending = Promise.withResolvers<Response>();
  let details = 0;
  let lists = 0;
  setApiHandler(async url => {
    if (url.includes("?")) lists++;
    if (url.endsWith(taskId)) {
      if (++details === 1) return pending.promise;
      return Response.json({ ...taskFixture(), status: "running", error: null, completed_at: null });
    }
    return defaults(url);
  });
  await mounted(async () => {
    await loaded();
    const socket = TaskSocket.instances.at(-1);
    assert.ok(socket);
    socket.onopen?.();
    await tick();
    await loaded();
    row().click();
    await eventually(() => assert.equal(details, 1));
    const before = lists;
    socket.emit({ type: "task_update", projectRef: "a", taskId, taskType: "queue:work", status: "running", timestamp: taskTime });
    // Let both notification debounce timers fire while the original detail read is still pending.
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok(lists > before);
    assert.equal(details, 1);
    pending.resolve(Response.json(taskFixture()));
    await eventually(() => assert.equal(button("TaskCenter.cancel_task").disabled, false));
    assert.ok(details >= 2);
    assert.equal(button("TaskCenter.retry").disabled, true);
  });
}

await boundariesAndSettings();
await staleProjectReads();
await selectionAndMutations();
await staleMutationsAndNotifications();
await cancellationAndSettingsNavigation();
await invalidationDuringDetailRead();
