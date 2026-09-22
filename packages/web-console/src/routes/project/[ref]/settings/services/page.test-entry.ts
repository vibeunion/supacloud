import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import ServicesPage from "./+page.svelte";
import { page, notifications } from "./page.test-fixture.svelte";
import { serviceControlFixture } from "../../../../../lib/project-services.test-fixtures";

const assert: { equal: typeof strictEqual; ok: typeof ok } = { equal: strictEqual, ok };
const originalFetch = globalThis.fetch;
function network(handler: (url: string, options: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) =>
    handler(String(input), options), originalFetch);
}
async function eventually(assertion: () => void) {
  const deadline = performance.now() + 4000;
  let error: unknown;
  do {
    try { assertion(); return; } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw error;
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(button =>
    button.textContent?.trim() === label || button.title === label);
  if (!result) throw new Error(`Missing service control ${label}`);
  return result;
}
function authRow(): Element {
  const owner = [...document.querySelectorAll("span")].find(span =>
    span.textContent?.startsWith("SupAuth") || span.textContent === "GoTrue");
  const row = owner?.closest(".px-6.py-4");
  if (!row) throw new Error("Missing auth service");
  return row;
}
async function loaded() {
  await tick();
  await eventually(() => {
    assert.equal(button("启动全部").disabled, false);
    assert.ok(authRow());
  });
}
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  notifications.length = 0;
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(ServicesPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function changeProject(ref: string | undefined) { page.params.ref = ref; await tick(); }

async function invalidAndOwnership() {
  let mode: "local" | "owner" | "shared" | "external" = "local";
  let invalid = true;
  let reads = 0;
  network(async () => {
    reads++;
    return Response.json(invalid ? {} : serviceControlFixture("a", mode));
  });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(button("启动全部").disabled, true);
    assert.equal(button("暂停项目").disabled, true);
    assert.equal(document.querySelector('[title="停止"]'), null);
    invalid = false;
    for (const next of ["shared", "external", "owner", "local"] as const) {
      mode = next;
      button("刷新").click();
      await loaded();
      const auth = authRow();
      assert.equal(auth.querySelectorAll("button").length, next === "shared" || next === "external" ? 0 : 2);
      assert.equal(button("暂停项目").disabled, next === "owner");
    }
    const count = reads;
    await changeProject(undefined);
    assert.equal(button("启动全部").disabled, true);
    assert.equal(document.querySelector('[title="停止"]'), null);
    assert.equal(reads, count);
  });
}

async function staleRead() {
  const pending = Promise.withResolvers<Response>();
  let aReads = 0;
  let disposed = false;
  network(async url => {
    if (url.includes("/a/") && ++aReads === 1) return pending.promise;
    return Response.json(serviceControlFixture(url.includes("/b/") ? "b" : "a", "shared"));
  });
  await mounted(async () => {
    await eventually(() => assert.equal(aReads, 1));
    await changeProject("b");
    await loaded();
    await changeProject("a");
    await loaded();
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.equal(authRow().querySelectorAll("button").length, 0);
    assert.equal(notifications.length, 0);
  });
}

async function mutations() {
  const pending = Promise.withResolvers<Response>();
  let writes = 0;
  let reads = 0;
  network(async (url, options) => {
    if (options.method === "POST") {
      assert.equal(url, "/v1/projects/a/restart");
      return ++writes === 1 ? pending.promise : Response.json({ ref: "a", action: "restart", success: true });
    }
    reads++;
    return Response.json(serviceControlFixture());
  });
  await mounted(async () => {
    await loaded();
    button("重启全部").click();
    button("重启全部").click();
    await eventually(() => assert.equal(writes, 1));
    assert.equal(button("启动全部").disabled, true);
    pending.resolve(Response.json({ ref: "wrong", action: "restart", success: true }));
    await eventually(() => assert.equal(notifications.length, 1));
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    button("重启全部").click();
    await eventually(() => assert.equal(reads, 2));
    await loaded();
    assert.equal(writes, 2);
  });
}

async function staleMutation() {
  const pending = Promise.withResolvers<Response>();
  let writes = 0;
  let disposed = false;
  network(async (url, options) => {
    if (options.method === "POST") { writes++; return pending.promise; }
    return Response.json(serviceControlFixture(url.includes("/b/") ? "b" : "a", "shared"));
  });
  await mounted(async () => {
    await loaded();
    button("重启全部").click();
    await eventually(() => assert.equal(writes, 1));
    await changeProject("b");
    await loaded();
    await changeProject("a");
    await loaded();
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.equal(notifications.length, 0);
    assert.equal(authRow().querySelectorAll("button").length, 0);
    assert.equal(writes, 1);
  });
}

try {
  await invalidAndOwnership();
  await staleRead();
  await mutations();
  await staleMutation();
} finally {
  globalThis.fetch = originalFetch;
}
