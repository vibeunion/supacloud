import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import ProjectsPage from "./+page.svelte";
import { projectListFixture } from "../../lib/project-list.test-fixtures";

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
function refreshButton() {
  const found = document.querySelector('button[title="Refresh"]');
  if (!(found instanceof HTMLButtonElement)) throw new Error("Missing project refresh button");
  return found;
}
function cards() { return document.querySelectorAll("[data-project-ref]"); }
async function mounted(run: () => Promise<void>) {
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(ProjectsPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function ready(ref = "a") {
  await tick();
  await eventually(() => assert.ok(document.querySelector(`[data-project-ref="${ref}"]`)));
}

async function invalidEmptyAndRecovery() {
  let payload: unknown = {};
  network(async () => Response.json(payload));
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(cards().length, 0);
    assert.equal(document.body.textContent?.includes("No projects found."), false);
    payload = [];
    refreshButton().click();
    await eventually(() => assert.ok(document.body.textContent?.includes("No projects found.")));
    assert.equal(document.querySelector('[role="alert"]'), null);
    payload = projectListFixture(["a", "b"]);
    refreshButton().click();
    await ready();
    assert.equal(cards().length, 2);
    assert.equal(document.querySelector('[data-project-ref="a"]')?.getAttribute("href"), "/project/a");
    assert.ok(document.querySelector('a[href="/projects/create"]'));
    payload = [{ ...projectListFixture()[0], ref: "../bad" }];
    refreshButton().click();
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(cards().length, 0);
    assert.equal(document.body.textContent?.includes("No projects found."), false);
  });
}

async function refreshFailure() {
  const pending = Promise.withResolvers<Response>();
  let reads = 0;
  network(async () => ++reads === 1 ? Response.json(projectListFixture()) : pending.promise);
  await mounted(async () => {
    await ready();
    refreshButton().click();
    await tick();
    assert.equal(cards().length, 0);
    assert.ok(document.querySelector('[role="status"]'));
    pending.resolve(new Response("private backend failure", { status: 503 }));
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(cards().length, 0);
    assert.equal(document.body.textContent?.includes("private backend failure"), false);
    assert.equal(document.body.textContent?.includes("No projects found."), false);
  });
}

async function staleMount() {
  const pending = Promise.withResolvers<Response>();
  let reads = 0;
  let disposed = false;
  network(async () => ++reads === 1 ? pending.promise : Response.json(projectListFixture(["b"])));
  await mounted(async () => { await eventually(() => assert.equal(reads, 1)); });
  await mounted(async () => {
    await ready("b");
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.equal(cards().length, 1);
    assert.equal(document.querySelector('[data-project-ref="a"]'), null);
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
}

try {
  await invalidEmptyAndRecovery();
  await refreshFailure();
  await staleMount();
} finally {
  globalThis.fetch = originalFetch;
}
