import { ok, strictEqual } from "node:assert";
import { mount, tick, unmount } from "svelte";
import Harness from "./rows.test-harness.svelte";
import { columns, fixture, page } from "./rows.test-fixture.svelte";

const calls: Request[] = [];
let handler: (request: Request) => Response | Promise<Response> = defaultResponse;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, options?: RequestInit) => {
    const request = new Request(input, options);
    calls.push(request);
    return handler(request);
  },
  originalFetch,
);
function defaultResponse(request: Request): Response {
  const path = new URL(request.url).pathname;
  const ref = path.split("/")[3];
  const table = path.split("/")[7];
  if (path.endsWith("/columns")) return Response.json({ data: columns });
  if (path.endsWith("/rows")) return Response.json({ data: [{
    id: `${ref}-${table}-row`, payload: { toString: null },
  }], total: 1 });
  throw new Error(`Unexpected fixture URL: ${path}`);
}
async function eventually(assertion: () => void) {
  const deadline = performance.now() + 3_000;
  let last: unknown;
  while (performance.now() < deadline) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Table rows assertion failed: ${document.body.textContent?.slice(0, 4000)}`, { cause: last });
}
function hasRow(value: string): boolean {
  return [...document.querySelectorAll("td")].some(cell => cell.textContent?.trim() === value);
}
function alertText(): string {
  return [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(" ");
}
async function navigate(ref: string, table = "users") {
  fixture.tenant = { tenantId: ref };
  page.params = { ref, schema: "public", table_name: table };
  await tick();
}
async function withView(run: () => Promise<void>, withTenant = true) {
  calls.length = 0;
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target, props: { withTenant } });
  try { await run(); } finally {
    await unmount(component);
    target.remove();
  }
  ok(calls.every(request => request.method === "GET"), "Read-only table must not mutate data");
}

try {
  await navigate("a");
  await withView(async () => {
    await eventually(() => ok(alertText().includes("Project context unavailable")));
    strictEqual(calls.length, 0);
  }, false);

  fixture.tenant = { tenantId: "b" };
  await withView(async () => {
    await eventually(() => ok(alertText().includes("Project context unavailable")));
    strictEqual(calls.length, 0);
    await navigate("a");
    await eventually(() => ok(hasRow("a-users-row")));
    ok(document.body.textContent?.includes('{"toString":null}'));
    fixture.tenant = { tenantId: "b" };
    await tick();
    await eventually(() => ok(alertText().includes("Project context unavailable")));
    strictEqual(hasRow("a-users-row"), false);
    strictEqual(calls.filter(request => new URL(request.url).pathname.includes("/b/")).length, 0);
  });

  await navigate("a");
  let malformed = true;
  handler = request => new URL(request.url).pathname.endsWith("/columns") && malformed
    ? Response.json({ data: columns.map(column => ({ ...column, is_nullable: "maybe" })) }) : defaultResponse(request);
  await withView(async () => {
    await eventually(() => ok(alertText().includes("Failed to load table columns")));
    strictEqual(calls.filter(request => new URL(request.url).pathname.endsWith("/rows")).length, 0);
    malformed = false;
    const retry = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry");
    ok(retry);
    retry.click();
    await eventually(() => ok(hasRow("a-users-row")));
  });

  const stale = Promise.withResolvers<Response>();
  let first = true;
  handler = request => {
    if (new URL(request.url).pathname === "/v1/projects/a/database/tables/public/users/columns" && first) {
      first = false;
      return stale.promise;
    }
    return defaultResponse(request);
  };
  await withView(async () => {
    await eventually(() => strictEqual(calls.length, 1));
    const oldRead = calls[0];
    ok(oldRead);
    await navigate("b");
    await eventually(() => ok(hasRow("b-users-row")));
    strictEqual(oldRead.signal.aborted, true);
    await navigate("a");
    await eventually(() => ok(hasRow("a-users-row")));
    const rowReads = calls.filter(request => new URL(request.url).pathname.endsWith("/rows")).length;
    stale.resolve(Response.json({ data: [{ ...columns[0], column_name: "stale-column" }] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    strictEqual(document.body.textContent?.includes("stale-column"), false);
    strictEqual(calls.filter(request => new URL(request.url).pathname.endsWith("/rows")).length, rowReads);
    await navigate("a", "events");
    strictEqual(hasRow("a-users-row"), false);
    await eventually(() => ok(hasRow("a-events-row")));
  });
} finally {
  globalThis.fetch = originalFetch;
}
