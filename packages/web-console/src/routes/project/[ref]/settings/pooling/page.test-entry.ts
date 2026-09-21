import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import PoolingPage from "./+page.svelte";
import { page, notifications } from "./page.test-fixture.svelte";
import { poolingFixture } from "../../../../../lib/project-pooling.test-fixtures";

const assert: { equal: typeof strictEqual; ok: typeof ok } = { equal: strictEqual, ok };
const originalFetch = globalThis.fetch;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function network(handler: (url: string, options: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) =>
    handler(String(input), options), originalFetch);
}
function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
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
  const found = [...document.querySelectorAll("button")].find(button => button.title === label);
  if (!found) throw new Error(`Missing pooling button ${label}`);
  return found;
}
function connection(kind = "pooler") {
  return document.querySelector(`[data-connection="${kind}"]`)?.textContent ?? null;
}
async function ready(ref = "a") {
  await tick();
  await eventually(() => assert.ok(connection()?.includes(`user_${ref}:`)));
}
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  notifications.length = 0;
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(PoolingPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function changeProject(ref: string | undefined) { page.params.ref = ref; await tick(); }

async function invalidAndRecovery() {
  let valid = false;
  let reads = 0;
  network(async () => { reads++; return Response.json(valid ? poolingFixture() : {}); });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(connection(), null);
    assert.equal(document.querySelector('[title="复制连接池地址"]'), null);
    valid = true;
    button("刷新").click();
    await ready();
    assert.equal(document.querySelector('[data-setting="mode"]')?.textContent, "未提供");
    assert.equal(document.querySelector('[data-setting="size"]')?.textContent, "未提供");
    assert.equal(connection(), "postgresql://user_a:[YOUR-PASSWORD]@pool.example.test:6644/db_a?pgbouncer=true");
    assert.equal(connection("direct"), "postgresql://user_a:[YOUR-PASSWORD]@db.example.test:5544/db_a");
    valid = false;
    button("刷新").click();
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(connection(), null);
    const count = reads;
    await changeProject(undefined);
    assert.equal(button("刷新").disabled, true);
    assert.equal(reads, count);
  });
}

async function staleRead() {
  const pending = Promise.withResolvers<Response>();
  let aReads = 0;
  let disposed = false;
  network(async url => {
    if (url.includes("/a/") && ++aReads === 1) return pending.promise;
    return Response.json(poolingFixture(url.includes("/b/") ? "b" : "a"));
  });
  await mounted(async () => {
    await eventually(() => assert.equal(aReads, 1));
    await changeProject("b");
    assert.equal(connection(), null);
    await ready("b");
    await changeProject("a");
    await ready();
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.ok(connection()?.includes("user_a:"));
    assert.equal(notifications.length, 0);
  });
}

async function copyScope() {
  const pending = Promise.withResolvers<void>();
  const copied: string[] = [];
  clipboard(async value => { copied.push(value); await pending.promise; });
  network(async url => Response.json(poolingFixture(url.includes("/b/") ? "b" : "a", {
    pgbouncer: { pool_mode: "statement", default_pool_size: 0 },
  })));
  await mounted(async () => {
    await ready();
    assert.equal(document.querySelector('[data-setting="mode"]')?.textContent, "statement");
    assert.equal(document.querySelector('[data-setting="size"]')?.textContent, "0");
    button("复制连接池地址").click();
    button("复制连接池地址").click();
    await tick();
    assert.equal(copied.length, 1);
    assert.equal(copied[0], connection());
    assert.equal(button("复制直连地址").disabled, true);
    await changeProject("b");
    await ready("b");
    await changeProject("a");
    await ready();
    pending.resolve();
    await tick();
    assert.equal(notifications.length, 0);
    clipboard(async () => { throw new Error("private clipboard failure"); });
    button("复制直连地址").click();
    await eventually(() => assert.equal(notifications.length, 1));
    assert.equal(notifications[0], "error:复制失败");
    clipboard(async value => { copied.push(value); });
    button("复制直连地址").click();
    await eventually(() => assert.equal(notifications.length, 2));
    assert.equal(notifications[1], "success:连接字符串已复制");
    assert.equal(copied[1], connection("direct"));
  });
}

try {
  await invalidAndRecovery();
  await staleRead();
  await copyScope();
} finally {
  globalThis.fetch = originalFetch;
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
}
