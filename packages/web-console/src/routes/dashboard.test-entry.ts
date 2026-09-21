import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import Dashboard from "./+page.svelte";
import { projectListFixture } from "../lib/project-list.test-fixtures";
import { systemFixture, destination } from "./dashboard.test-fixture";

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
  const button = document.querySelector('button[title="Refresh"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing refresh button");
  button.click();
}
function metric(name: string) { return document.querySelector(`[data-metric="${name}"]`)?.textContent; }
function text() { return document.body.textContent ?? ""; }
function rows() { return document.querySelectorAll("[data-project-ref]"); }
async function mounted(run: () => Promise<void>) {
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Dashboard, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}

async function independentResources() {
  let projects: unknown = {};
  let system: unknown = systemFixture;
  network(async url => Response.json(url === "/v1/projects" ? projects : system));
  await mounted(async () => {
    await eventually(() => assert.ok(text().includes("Management API partially available")));
    assert.equal(metric("projects"), "\u2014");
    assert.equal(metric("cpu"), "25.0%");
    assert.equal(text().includes("No projects yet"), false);
    assert.equal(rows().length, 0);
    projects = projectListFixture(["a", "b"]);
    system = {};
    refresh();
    await eventually(() => assert.equal(rows().length, 2));
    await eventually(() => assert.ok(text().includes("System data is temporarily unavailable.")));
    assert.equal(metric("cpu"), "\u2014");
    assert.equal(metric("projects"), "2");
    assert.ok(text().includes("Enabled"));
    assert.equal(text().includes("postgres"), false);
    assert.equal(document.querySelector('[aria-label="Instance online"]'), null);
    assert.equal(document.querySelector(".health-score")?.textContent?.includes("online"), false);
    projects = [];
    system = systemFixture;
    refresh();
    await eventually(() => assert.equal(metric("projects"), "0"));
    assert.equal(document.querySelector(".health-score strong")?.textContent, "\u2014");
    assert.equal(document.querySelector(".health-track"), null);
    const create = document.querySelector(".empty-state button");
    if (!(create instanceof HTMLButtonElement)) throw new Error("Missing creation button");
    create.click();
    assert.equal(destination, "/projects/create");
  });
}

async function clearFailedRefresh() {
  const pendingProject = Promise.withResolvers<Response>();
  const pendingSystem = Promise.withResolvers<Response>();
  let projectReads = 0;
  let systemReads = 0;
  network(async url => url === "/v1/projects"
    ? ++projectReads === 1 ? Response.json(projectListFixture()) : pendingProject.promise
    : ++systemReads === 1 ? Response.json(systemFixture) : pendingSystem.promise);
  await mounted(async () => {
    await eventually(() => assert.equal(rows().length, 1));
    await eventually(() => assert.equal(metric("cpu"), "25.0%"));
    refresh();
    await tick();
    assert.equal(rows().length, 0);
    assert.equal(metric("projects"), "\u2014");
    assert.equal(metric("cpu"), "\u2014");
    assert.ok(document.querySelector('[role="status"]'));
    pendingSystem.resolve(new Response("private system failure", { status: 503 }));
    await eventually(() => assert.ok(text().includes("System data is temporarily unavailable.")));
    assert.ok(document.querySelector('[role="status"]'));
    pendingProject.resolve(new Response("private project failure", { status: 503 }));
    await eventually(() => assert.ok(text().includes("Management API unavailable")));
    assert.equal(text().includes("private"), false);
    assert.equal(metric("projects"), "\u2014");
    assert.equal(document.querySelector(".empty-state button"), null);
  });
}

async function raceAndUnmount() {
  const late = Promise.withResolvers<Response>();
  const lateSystem = Promise.withResolvers<Response>();
  const firstSignals: AbortSignal[] = [];
  let reads = 0;
  let disposed = 0;
  network(async (url, options) => {
    if (++reads <= 2) {
      if (options.signal) firstSignals.push(options.signal);
      return url === "/v1/projects" ? late.promise : lateSystem.promise;
    }
    return Response.json(url === "/v1/projects" ? projectListFixture(["b"]) : systemFixture);
  });
  await mounted(async () => {
    await eventually(() => assert.equal(reads, 2));
    refresh();
    await eventually(() => assert.ok(document.querySelector('[data-project-ref="b"]')));
    assert.ok(firstSignals.every(signal => signal.aborted));
    late.resolve(new Response(new ReadableStream({ cancel() { disposed++; } })));
    lateSystem.resolve(new Response(new ReadableStream({ cancel() { disposed++; } })));
    await eventually(() => assert.equal(disposed, 2));
    assert.equal(rows().length, 1);
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
  const unmounted = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  network(async (_url, options) => {
    if (options.signal) signals.push(options.signal);
    return unmounted.promise;
  });
  await mounted(async () => { await eventually(() => assert.equal(signals.length, 2)); });
  assert.ok(signals.every(signal => signal.aborted));
  unmounted.resolve(Response.json({}));
}

async function sortAndFutureDate() {
  const first = projectListFixture(["a"])[0];
  const second = projectListFixture(["b"])[0];
  network(async url => Response.json(url === "/v1/projects"
    ? [{ ...first, status: "INACTIVE" }, { ...second, created_at: "9999-01-01T00:00:00.000Z", status: "COMING_UP" }]
    : systemFixture));
  await mounted(async () => {
    await eventually(() => assert.equal(rows().length, 2));
    assert.equal(rows()[0]?.getAttribute("data-project-ref"), "b");
    assert.ok(rows()[0]?.textContent?.includes("9999-01-01T00:00:00.000Z"));
    assert.ok(rows()[0]?.textContent?.includes("Creating"));
    assert.ok(rows()[1]?.textContent?.includes("Inactive"));
  });
}

try {
  await independentResources();
  await clearFailedRefresh();
  await raceAndUnmount();
  await sortAndFutureDate();
} finally {
  globalThis.fetch = originalFetch;
}
