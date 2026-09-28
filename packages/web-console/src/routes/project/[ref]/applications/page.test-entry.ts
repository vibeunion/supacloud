import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import Dashboard from "./+page.svelte";
import { page } from "./page.test-fixture.svelte";

const originalFetch = globalThis.fetch;
const a = "a".repeat(64), b = "b".repeat(64);
function runtime(ref: string, app: string, env: string) {
  return { project_ref: ref, application_id: app, environment_id: env, readiness: null };
}
function inventory(ref: string, app: string, id = a, next: string | null = null) {
  return { project_ref: ref, application_id: app, next_cursor: next, releases: [{
    schema: "supacloud.application-release.v1", project_ref: ref, application_id: app,
    release_id: id, manifest_sha256: "d".repeat(64), created_at: "2026-09-28T00:00:00.000Z",
    targets: [{ name: "api", kind: "http", object_id: "c".repeat(64), entrypoint: "bundle/index.js" }],
  }] };
}
function network(handler: (url: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(async (url: RequestInfo | URL, init: RequestInit = {}) =>
    handler(String(url), init), originalFetch);
}
async function eventually(check: () => void) {
  let error: unknown;
  for (let i = 0; i < 300; i++) {
    try { check(); return; } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw error;
}
const text = () => document.body.textContent ?? "";
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(node =>
    node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  ok(found, `Missing button ${label}`);
  return found;
}
const target = document.body.appendChild(document.createElement("div"));
let component: ReturnType<typeof mount> | undefined;
try {
  const late = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  network(async (url, init) => {
    urls.push(url);
    if (url.includes("/demo/")) { signals.push(init.signal!); return late.promise; }
    if (url.endsWith("/runtime")) return Response.json({ error: "private-error" }, { status: 503 });
    return Response.json(inventory("other", "next-app", url.includes("cursor=") ? b : a,
      url.includes("cursor=") ? null : a));
  });
  component = mount(Dashboard, { target });
  await eventually(() => strictEqual(signals.length, 2));
  page.params.ref = "other";
  page.url = new URL("http://localhost/project/other/applications?application=next-app&environment=prod");
  await eventually(() => ok(text().includes(a)));
  ok(signals.every(signal => signal.aborted));
  ok(text().includes("Data unavailable"));
  ok(!text().includes("private-error"));
  late.resolve(Response.json(inventory("demo", "reviews", "f".repeat(64))));
  await tick();
  ok(!text().includes("f".repeat(64)));
  button("Next").click();
  await eventually(() => ok(text().includes(b)));
  ok(urls.some(url => url.endsWith(`cursor=${a}`)));
  strictEqual(button("Next").disabled, true);
  button("Previous").click();
  await eventually(() => ok(text().includes(a)));
  strictEqual(button("Previous").disabled, true);

  network(async url => url.endsWith("/runtime")
    ? Response.json(runtime("other", "next-app", "prod"))
    : new Response("{"));
  button("Refresh").click();
  await eventually(() => ok(text().includes("No active activation record")));
  await eventually(() => ok(text().includes("Data unavailable")));
  ok(!text().includes(a));
  ok(!text().includes("No stored releases"));

  const hanging = Promise.withResolvers<Response>();
  const unmountSignals: AbortSignal[] = [];
  network(async (_url, init) => { unmountSignals.push(init.signal!); return hanging.promise; });
  button("Refresh").click();
  await eventually(() => strictEqual(unmountSignals.length, 2));
  await unmount(component);
  component = undefined;
  ok(unmountSignals.every(signal => signal.aborted));
  hanging.resolve(Response.json({}));
} finally {
  if (component) await unmount(component);
  target.remove();
  globalThis.fetch = originalFetch;
}
