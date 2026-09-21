import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import HostingPage from "./+page.svelte";
import { page } from "./list.test-fixture.svelte";
import { hostingDeployment } from "../../../../lib/hosting-list.test-fixtures";

const assert: { equal: typeof strictEqual; deepEqual: typeof deepStrictEqual; ok: typeof ok } =
  { equal: strictEqual, deepEqual: deepStrictEqual, ok };
const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;
globalThis.confirm = () => true;

function network(handler: (url: string, options: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, options: RequestInit = {}) => handler(String(input), options),
    originalFetch,
  );
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
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing hosting command ${label}`);
  return result;
}
function receipt(operation: "delete_deployment" | "redeploy", projectRef = "a") {
  return { success: true, operation, project_ref: projectRef, deployment_id: "dep-a",
    ...(operation === "redeploy" ? { url: "https://site.example.com", build_log: "" } : {}) };
}
function list(projectRef = "a") { return Response.json({ deployments: [hostingDeployment(projectRef)] }); }
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(HostingPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function loaded(ref = "a") {
  await eventually(() => {
    assert.equal(document.querySelector("h3")?.textContent, `Site ${ref}`);
    assert.equal(button("Hosting.refresh").disabled, false);
  });
}
async function changeProject(ref: string | undefined) { page.params.ref = ref; await tick(); }

async function invalidAndRecovery() {
  let valid = false;
  let calls = 0;
  network(async () => { calls++; return valid ? list() : list("wrong"); });
  await mounted(async () => {
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(document.querySelector("h3"), null);
    assert.equal(calls, 1);
    valid = true;
    button("Hosting.refresh").click();
    await loaded();
    assert.equal(calls, 2);
    await changeProject(undefined);
    assert.equal(document.querySelector("h3"), null);
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(button("Hosting.refresh").disabled, true);
    assert.equal(calls, 2);
  });
}
async function staleLists() {
  const pending = Promise.withResolvers<Response>();
  let aReads = 0;
  let disposed = false;
  network(async url => {
    if (url.includes("/a/") && ++aReads === 1) return pending.promise;
    return list(url.includes("/b/") ? "b" : "a");
  });
  await mounted(async () => {
    await eventually(() => assert.equal(aReads, 1));
    await changeProject("b");
    await loaded("b");
    await changeProject("a");
    await loaded();
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.equal(document.querySelector("h3")?.textContent, "Site a");
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
}
async function mutationReceipts() {
  const pending = Promise.withResolvers<Response>();
  const calls: Array<{ url: string; method: string }> = [];
  let reads = 0;
  let writes = 0;
  network(async (url, options) => {
    if (options.method === "DELETE" || options.method === "POST") {
      calls.push({ url, method: options.method });
      return ++writes === 1 ? pending.promise : Response.json(receipt("redeploy"));
    }
    reads++;
    return list();
  });
  await mounted(async () => {
    await loaded();
    const remove = button("删除");
    remove.click();
    remove.click();
    await eventually(() => assert.equal(calls.length, 1));
    assert.equal(remove.disabled, true);
    assert.equal(button("↻ 重新部署").disabled, true);
    pending.resolve(Response.json(receipt("delete_deployment", "wrong")));
    await eventually(() => assert.ok(document.body.textContent?.includes("could not be confirmed")));
    assert.equal(document.body.textContent?.includes("部署已删除"), false);
    assert.equal(reads, 1);
    assert.equal(calls.length, 1);
    button("↻ 重新部署").click();
    await eventually(() => assert.ok(document.body.textContent?.includes("重新部署已完成")));
    await loaded();
    assert.deepEqual(calls, [
      { url: "/v1/projects/a/frontend/deployments/dep-a", method: "DELETE" },
      { url: "/v1/projects/a/frontend/deployments/dep-a/redeploy", method: "POST" },
    ]);
    assert.equal(reads, 2);
  });
}
async function staleMutation() {
  const pending = Promise.withResolvers<Response>();
  let writes = 0;
  let disposed = false;
  network(async (url, options) => {
    if (options.method === "DELETE") { writes++; return pending.promise; }
    return list(url.includes("/b/") ? "b" : "a");
  });
  await mounted(async () => {
    await loaded();
    button("删除").click();
    await eventually(() => assert.equal(writes, 1));
    await changeProject("b");
    await loaded("b");
    await changeProject("a");
    await loaded();
    pending.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.equal(disposed, true));
    assert.equal(document.body.textContent?.includes("部署已删除"), false);
    assert.equal(document.body.textContent?.includes("could not be confirmed"), false);
    assert.equal(button("删除").disabled, false);
    assert.equal(writes, 1);
  });
}

try {
  await invalidAndRecovery();
  await staleLists();
  await mutationReceipts();
  await staleMutation();
} finally {
  globalThis.fetch = originalFetch;
  globalThis.confirm = originalConfirm;
}
