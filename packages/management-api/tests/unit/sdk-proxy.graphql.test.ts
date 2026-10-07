// @supacloud-test-isolate
import { afterEach, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { sdkProxyInternals, sdkProxyRoutes, setSdkProxyFetchForTests, setSdkProxySqlForTests } from "../../src/routes/sdk-proxy";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  setSdkProxyFetchForTests();
  setSdkProxySqlForTests();
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup(policy: unknown, fail = false) {
  spies.push(spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockResolvedValue("demo"));
  spies.push(spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue(null));
  let forwarded = 0;
  setSdkProxySqlForTests(async () => {
    if (fail) throw new Error("postgres://private:secret@host/db");
    return [{ config: { gotrue_port: 7360, postgrest_port: 7361, graphql_governance: policy } }];
  });
  setSdkProxyFetchForTests((async () => {
    forwarded += 1;
    return Response.json({ data: { id: 1 } }, { headers: { "access-control-allow-origin": "https://example.test" } });
  }) as typeof fetch);
  const app = new Elysia().use(sdkProxyRoutes);
  const send = (query: string, variables?: Record<string, unknown>, method = "POST") => {
    const body = { query, ...(variables ? { variables } : {}) };
    const url = method === "GET" ? `http://localhost/graphql/v1?${new URLSearchParams({ query, variables: JSON.stringify(variables ?? {}) })}`
      : "http://localhost/graphql/v1";
    return app.handle(new Request(url, { method, headers: { apikey: "fixture", "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }));
  };
  return { send, forwarded: () => forwarded };
}
test("actual GraphQL proxy rejects POST/GET oversized variables and repeated fragment budgets before upstream", async () => {
  const context = setup({ enabled: true, maxPageSize: 20, maxFields: 4 });
  for (const method of ["POST", "GET"]) {
    const result = await context.send("query Page($n: Int!) { orders(first: $n) { id } }", { n: 100 }, method);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "GRAPHQL_OPERATION_BUDGET_EXCEEDED" });
  }
  const fragments = await context.send("query Q { a { ...F } b { ...F } } fragment F on Item { id name }");
  expect(fragments.status).toBe(400);
  expect(context.forwarded()).toBe(0);
});
test("actual GraphQL proxy fails closed and redacts a policy database failure", async () => {
  const context = setup({ enabled: true }, true);
  const response = await context.send("query Q { id }");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "GRAPHQL_POLICY_UNAVAILABLE", error: "GraphQL policy is unavailable" });
  expect(context.forwarded()).toBe(0);
});
test("actual GraphQL proxy still forwards allowed requests and upstream CORS unchanged", async () => {
  const context = setup({ enabled: true, maxPageSize: 20 });
  const response = await context.send("query Page($n: Int!) { orders(first: $n) { id } }", { n: 20 });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
  expect(context.forwarded()).toBe(1);
});
