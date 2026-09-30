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
function development(ref: string, app: string) {
  return {
    project_ref: ref, application_id: app, release_id: a, target: "api", object_id: "c".repeat(64),
    correlation: "verified-build-snapshot",
    context: {
      schema: "supacloud.application-development.v1", source: "current-graph", deploymentVerified: false,
      modules: [], routes: [], commands: [], jobs: [], resourceUses: [], executionPlans: [],
      resources: [{ name: "reviews-db", kind: "database" }],
      diagnostics: [
        { code: "SC8103", severity: "warn", file: "src/reviews.ts", line: 10 },
        { code: "SC8103", severity: "warn", file: "src/reviews.ts", line: 20 },
      ],
      omitted: { modules: 0, providers: 0, routes: 0, commands: 0, jobs: 0, resources: 0, resourceUses: 0, plans: 0, diagnostics: 0 },
      limits: { outputBytes: 65536, modules: 64, providers: 128, routes: 256, commands: 128, jobs: 128,
        resources: 64, resourceUses: 128, plans: 128, diagnostics: 64 },
    },
  };
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

  network(async url => {
    urls.push(url);
    if (url.endsWith("/runtime")) return Response.json(runtime("other", "next-app", "prod"));
    if (url.includes("/development")) return Response.json(development("other", "next-app"));
    return Response.json(inventory("other", "next-app", a));
  });
  button("Refresh").click();
  await eventually(() => ok(text().includes(a)));
  button("api").click();
  await eventually(() => ok(text().includes("Verified build snapshot")));
  strictEqual(text().match(/SC8103/g)?.length, 2);
  ok(text().includes("src/reviews.ts:10") && text().includes("src/reviews.ts:20"));
  ok(urls.some(url => url.includes(`/releases/${a}/development?target=api`)));

  network(async () => Response.json({ ...development("other", "next-app"), object_id: "d".repeat(64) }));
  button("api").click();
  await eventually(() => ok(document.querySelector('[role="alert"]')));
  ok(!text().includes("Verified build snapshot"));

  const pendingDevelopment = Promise.withResolvers<Response>();
  const developmentSignals: AbortSignal[] = [];
  network(async (url, init) => {
    if (url.includes("/development")) { developmentSignals.push(init.signal!); return pendingDevelopment.promise; }
    if (url.endsWith("/runtime")) return Response.json(runtime("third", "third-app", "prod"));
    return Response.json(inventory("third", "third-app", b));
  });
  button("api").click();
  await eventually(() => strictEqual(developmentSignals.length, 1));
  page.params.ref = "third";
  page.url = new URL("http://localhost/project/third/applications?application=third-app&environment=prod");
  await eventually(() => ok(text().includes(b)));
  ok(developmentSignals[0]?.aborted);
  pendingDevelopment.resolve(Response.json(development("other", "next-app")));
  await tick();
  ok(!text().includes("SC8103"));
  ok(!text().includes("Verified build snapshot"));

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
