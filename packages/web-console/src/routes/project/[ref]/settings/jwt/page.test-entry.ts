import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import JwtPage from "./+page.svelte";
import { page, jwtFixture, notifications } from "./page.test-fixture.svelte";

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
  const result = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === label || button.title === label);
  if (!result) throw new Error(`Missing JWT control ${label}`);
  return result;
}
function text() { return document.body.textContent ?? ""; }
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  notifications.length = 0;
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(JwtPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function change(ref: string | undefined) { page.params.ref = ref; await tick(); }
async function ready(ref = "a") {
  await eventually(() => assert.ok(text().includes(`key-${ref}`)));
}
async function invalidAndOwnership() {
  let payload: unknown = {};
  let reads = 0;
  network(async (url, options) => {
    reads++;
    assert.equal(url, "/v1/projects/a/auth/jwt-settings");
    assert.equal(options.method === "POST", false);
    return Response.json(payload);
  });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(document.querySelector('[title="复制 JWKS URL"]'), null);
    assert.equal(reads, 1);
    payload = jwtFixture();
    button("刷新").click();
    await ready();
    assert.ok(text().includes("1 小时"));
    payload = { project_ref: "a", execution_mode: "shared", authority_project_ref: "owner", policy: null, signing: null };
    button("刷新").click();
    await eventually(() => assert.ok(document.querySelector('a[href="/project/owner/settings/jwt"]')));
    assert.equal(text().includes("key-a"), false);
    assert.equal(document.querySelector('[title="复制 JWKS URL"]'), null);
    payload = { project_ref: "a", execution_mode: "external", authority_project_ref: null, policy: null, signing: null };
    button("刷新").click();
    await eventually(() => assert.ok(text().includes("JWT 由外部认证服务管理")));
    assert.equal(document.querySelector('a[href="/project/owner/settings/jwt"]'), null);
    payload = jwtFixture("b");
    button("刷新").click();
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(text().includes("key-b"), false);
  });
}
async function races() {
  const late = Promise.withResolvers<Response>();
  let reads = 0;
  let disposed = false;
  const signals: AbortSignal[] = [];
  network(async (url, options) => {
    if (options.signal) signals.push(options.signal);
    return ++reads === 1 ? late.promise : Response.json(jwtFixture(url.includes("/b/") ? "b" : "a"));
  });
  await mounted(async () => {
    await eventually(() => assert.equal(reads, 1));
    await change("b");
    await ready("b");
    await change("a");
    await ready();
    assert.ok(signals[0]?.aborted);
    late.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.ok(disposed));
    assert.equal(document.querySelector('[role="alert"]'), null);
    const count = reads;
    await change(undefined);
    assert.equal(document.querySelector('[title="复制 JWKS URL"]'), null);
    assert.equal(reads, count);
  });
  const unmounted = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  network(async (_url, options) => { signal = options.signal; return unmounted.promise; });
  await mounted(async () => { await eventually(() => assert.ok(signal)); });
  assert.ok(signal?.aborted);
  unmounted.resolve(Response.json(jwtFixture()));
}
async function clipboardScope() {
  const pending = Promise.withResolvers<void>();
  let writes = 0;
  const values: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    async writeText(value: string) { values.push(value); if (++writes === 1) await pending.promise; },
  } });
  network(async url => Response.json(jwtFixture(url.includes("/b/") ? "b" : "a")));
  await mounted(async () => {
    await ready();
    button("复制 JWKS URL").click();
    button("复制 JWKS URL").click();
    await tick();
    assert.equal(writes, 1);
    assert.equal(button("复制 JWKS URL").disabled, true);
    await change("b");
    await ready("b");
    pending.resolve();
    await tick();
    assert.equal(notifications.length, 0);
    button("复制 JWKS URL").click();
    await eventually(() => assert.equal(notifications.length, 1));
    assert.equal(values[1], jwtFixture("b").signing.jwks_url);
  });
  const refreshed = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText() { return refreshed.promise; },
  } });
  await mounted(async () => {
    await ready();
    button("复制 JWKS URL").click();
    button("刷新").click();
    await ready();
    refreshed.resolve();
    await tick();
    assert.equal(notifications.length, 0);
  });
  const unmounted = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText() { return unmounted.promise; },
  } });
  await mounted(async () => {
    await ready();
    button("复制 JWKS URL").click();
    await tick();
  });
  unmounted.reject(new Error("clipboard failed after unmount"));
  await tick();
  assert.equal(notifications.length, 0);
}

try {
  await invalidAndOwnership();
  await races();
  await clipboardScope();
} finally { globalThis.fetch = originalFetch; }
