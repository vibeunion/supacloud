import { expect, test } from "bun:test";
import { governGraphqlRequest, normalizeGraphqlRequestGovernancePolicy } from "../../src/services/graphql-request-governance";

test("accepts a pg_graphql request while checking persisted identity and budgets", async () => {
  const query = "query Orders { orders(first: 20) { id } }";
  const first = await governGraphqlRequest(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, operationName: "Orders" }),
    }),
    normalizeGraphqlRequestGovernancePolicy({ enabled: true, maxDepth: 3, maxFields: 10, maxComplexity: 10 }),
  );
  expect(first).toMatchObject({ operationName: "Orders", operationType: "query", fields: 2 });
  if (first instanceof Response) throw new Error("expected a governance report");
  const persisted = await governGraphqlRequest(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        operationName: "Orders",
        extensions: { persistedQuery: { version: 1, sha256Hash: first.sha256 } },
      }),
    }),
    normalizeGraphqlRequestGovernancePolicy({ enabled: true, persistedOnly: true }),
  );
  expect(persisted).toMatchObject({ sha256: first.sha256 });
});

test("rejects subscriptions on the pg_graphql HTTP path and over-budget operations", async () => {
  const subscription = await governGraphqlRequest(
    new Request("http://localhost/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "subscription Updates { updates { id } }" }),
    }),
    {},
  );
  expect(subscription).toBeInstanceOf(Response);
  expect(await (subscription as Response).json()).toMatchObject({ code: "GRAPHQL_SUBSCRIPTION_USE_REALTIME" });

  const denied = await governGraphqlRequest(
    new Request("http://localhost/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "query Orders { orders(first: 100) { id } }" }),
    }),
    { maxPageSize: 20 },
  );
  expect(denied).toBeInstanceOf(Response);
  expect(await (denied as Response).json()).toMatchObject({ code: "GRAPHQL_OPERATION_BUDGET_EXCEEDED" });
});
