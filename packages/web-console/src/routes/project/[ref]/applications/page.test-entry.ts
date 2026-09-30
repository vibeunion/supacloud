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
      diagnostics: [{ code: "SC8103", severity: "warn" }],
      omitted: { modules: 0 }, limits: { outputBytes: 65536 },
    },
  };
}
function evidence(ref: string, app: string) {
  return {
    project_ref: ref, application_id: app, release_id: a,
    schema: "supacloud.release-evidence.v1", correlation: "verified-build-snapshot",
    deploymentVerified: false, target: "api",
    build: { producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false, manifestSha256: "d".repeat(64), objectId: "c".repeat(64), entryKind: "bun-http-application", entrypoint: "bundle/index.js", files: 2, bytes: 64 },
    contract: { status: "present", schema: "supacloud.application-development.v1", resources: 1, diagnostics: { errors: 0, warnings: 1 } },
    migrations: { status: "absent", count: 0, latestVersion: null, executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required" },
    rollback: { application: "previous release", database: "repair path", storage: "object version" },
    notes: ["Local artifact integrity only."],
  };
}
function execution(ref: string, app: string) {
  const at = "2026-09-30T01:00:00.000Z";
  const component = (name: string, overrides: Record<string, unknown> = {}) => ({
    name, status: "unknown", required: false, version: null, detail: null, observedAt: null, ...overrides,
  });
  return {
    project_ref: ref, application_id: app, release_id: a,
    schema: "supacloud.release-execution.v1", correlation: "release-execution-observation",
    target: "api", manifestSha256: "d".repeat(64), deploymentVerified: true,
    components: [
      component("application", { status: "succeeded", required: true, observedAt: at }),
      component("migrations", { status: "succeeded", required: true, version: "2", observedAt: at }),
      component("configuration"), component("resources"), component("secrets"),
      component("health", { status: "succeeded", required: true, observedAt: at }),
    ],
    recovery: { application: "previous release", database: "repair path", storage: "object version" },
    notes: ["Runtime observation only."],
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
    if (url.includes("/execution")) return Response.json(execution("other", "next-app"));
    if (url.includes("/evidence")) return Response.json(evidence("other", "next-app"));
    return Response.json(inventory("other", "next-app", a));
  });
  button("Refresh").click();
  await eventually(() => ok(text().includes(a)));
  button("api").click();
  await eventually(() => ok(text().includes("Verified build snapshot")));
  ok(text().includes("SC8103"));
  ok(urls.some(url => url.includes(`/releases/${a}/development?target=api`)));
  button("Release evidence api").click();
  await eventually(() => ok(text().includes("Rollback paths")));
  ok(text().includes("previous release"));
  ok(urls.some(url => url.includes(`/releases/${a}/evidence?target=api`)));
  await eventually(() => ok(text().includes("Deployment verified")));
  ok(text().includes("Migrations"));
  ok(urls.some(url => url.includes(`/releases/${a}/execution?target=api`)));

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
