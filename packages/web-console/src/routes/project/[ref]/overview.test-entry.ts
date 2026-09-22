import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import Overview from "./+page.svelte";
import { page } from "./overview.test-fixture.svelte";
import { overviewFixture } from "../../../lib/project-overview.test-fixtures";
import { serviceControlFixture } from "../../../lib/project-services.test-fixtures";

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
function refresh() {
  const button = document.querySelector('button[aria-label="Refresh"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing refresh button");
  button.click();
}
function metric(name: string) { return document.querySelector(`[data-metric="${name}"]`)?.textContent; }
function text() { return document.body.textContent ?? ""; }
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Overview, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function change(ref: string | undefined) { page.params.ref = ref; await tick(); }

async function failureAndPartial() {
  const urls: string[] = [];
  let payload: unknown = {};
  network(async (url, options) => {
    urls.push(url);
    assert.equal(options.method === "POST", false);
    return Response.json(url.endsWith("/services/control-state") ? serviceControlFixture() : payload);
  });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(metric("tasks"), undefined);
    assert.equal(urls.length, 2);
    payload = { ...overviewFixture(), database: null, tasks: null, storage: null,
      auth: { source: "local", managed_by_ref: null, total_users: null, recent_users: null }, active_queries: null };
    refresh();
    await eventually(() => assert.equal(metric("database"), "-"));
    assert.equal(metric("connections"), "-");
    assert.equal(metric("users"), "-");
    assert.equal(metric("tasks"), "-");
    assert.equal(metric("storage"), "-");
    assert.equal(metric("functions"), "0");
    assert.ok(text().includes("Data unavailable"));
    payload = overviewFixture();
    refresh();
    await eventually(() => assert.equal(metric("tasks"), "0"));
    assert.equal(metric("users"), "0");
    assert.equal(metric("storage"), "0 bytes");
    assert.equal(document.querySelector('[role="alert"]'), null);
    payload = overviewFixture("b");
    refresh();
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(metric("users"), undefined);
    assert.ok(urls.every(url => url.endsWith("/dashboard/summary") || url.endsWith("/services/control-state")));
  });
}

async function ownership() {
  let source: "supauth" | "external" = "supauth";
  network(async url => Response.json(url.endsWith("/services/control-state") ? serviceControlFixture()
    : { ...overviewFixture(), auth: {
      source, managed_by_ref: source === "supauth" ? "owner-project" : null, total_users: null, recent_users: null,
    } }));
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('a[href="/project/owner-project/auth"]')));
    assert.equal(metric("users"), undefined);
    source = "external";
    refresh();
    await eventually(() => assert.ok(text().includes("External Auth")));
    assert.equal(document.querySelector('a[href="/project/owner-project/auth"]'), null);
    assert.equal(metric("users"), undefined);
  });
}

async function refreshAndProjectRaces() {
  const late = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  let summaryReads = 0;
  let disposed = false;
  network(async (url, options) => {
    const ref = url.includes("/b/") ? "b" : "a";
    if (url.endsWith("/services/control-state")) return Response.json(serviceControlFixture(ref));
    if (options.signal) signals.push(options.signal);
    if (++summaryReads === 1) return late.promise;
    return Response.json({ ...overviewFixture(ref), functions: { count: summaryReads } });
  });
  await mounted(async () => {
    await eventually(() => assert.equal(summaryReads, 1));
    await change("b");
    await eventually(() => assert.equal(metric("functions"), "2"));
    await change("a");
    await eventually(() => assert.equal(metric("functions"), "3"));
    late.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.ok(disposed));
    assert.equal(metric("functions"), "3");
    assert.ok(signals[0]?.aborted);
    const count = summaryReads;
    await change(undefined);
    assert.equal(metric("functions"), undefined);
    assert.equal(summaryReads, count);
  });
  const pending = Promise.withResolvers<Response>();
  let reads = 0;
  const unmountSignals: AbortSignal[] = [];
  network(async (url, options) => {
    if (url.endsWith("/services/control-state")) return Response.json(serviceControlFixture());
    if (++reads === 1) return Response.json(overviewFixture());
    if (options.signal) unmountSignals.push(options.signal);
    return pending.promise;
  });
  await mounted(async () => {
    await eventually(() => assert.equal(metric("functions"), "0"));
    refresh();
    await tick();
    assert.equal(metric("functions"), undefined);
    await eventually(() => assert.equal(unmountSignals.length, 1));
  });
  assert.ok(unmountSignals[0]?.aborted);
  pending.resolve(Response.json(overviewFixture()));
}

try {
  await failureAndPartial();
  await ownership();
  await refreshAndProjectRaces();
} finally { globalThis.fetch = originalFetch; }
