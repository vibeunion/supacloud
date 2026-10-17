import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parse, print, separateOperations } from "graphql";
import { governGraphqlRequest, governGraphqlProjectRequest, normalizeGraphqlRequestGovernancePolicy } from "../../src/services/graphql-request-governance";

const policy = { enabled: true, maxPageSize: 20, maxFields: 10, maxDepth: 4 };
function request(body: Record<string, unknown>, method = "POST") {
  if (method === "GET") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    return new Request(`http://localhost/graphql/v1?${params}`);
  }
  return new Request("http://localhost/graphql/v1", { method, body: JSON.stringify(body) });
}
async function code(result: Response | object) {
  expect(result).toBeInstanceOf(Response);
  return (await (result as Response).json()).code;
}
for (const method of ["POST", "GET"]) {
  test(`${method} enforces pagination variables and selected-operation defaults`, async () => {
    const query = "query Page($n: Int = 100) { orders(first: $n) { id } }";
    expect(await code(await governGraphqlRequest(request({ query }, method), policy))).toBe("GRAPHQL_OPERATION_BUDGET_EXCEEDED");
    expect(await code(await governGraphqlRequest(request({ query, variables: { n: 21 } }, method), policy))).toBe("GRAPHQL_OPERATION_BUDGET_EXCEEDED");
    expect(await governGraphqlRequest(request({ query, variables: { n: 20 } }, method), policy)).toMatchObject({ fields: 2, pageSizes: [20] });
    expect(await governGraphqlRequest(request({ query, variables: { n: 0 } }, method), policy)).toMatchObject({ pageSizes: [0] });
    // Explicit null must not accidentally apply the variable default.
    expect(await governGraphqlRequest(request({ query, variables: { n: null } }, method), policy)).toMatchObject({ pageSizes: [] });
    const multiple = "query Small($n: Int = 2) { orders(first: $n) { id } } query Large($n: Int = 999) { orders(first: $n) { id } }";
    expect(await governGraphqlRequest(request({ query: multiple, operationName: "Small" }, method), policy)).toMatchObject({ pageSizes: [2] });
  });
}
for (const n of ["20", true, [], {}, 1.5, -1, 2147483648, null]) {
  test(`rejects invalid or null required pagination variable ${JSON.stringify(n)}`, async () => {
    expect(await code(await governGraphqlRequest(request({ query: "query Page($n: Int!) { orders(first: $n) { id } }", variables: { n } }), policy)))
      .toBe("GRAPHQL_REQUEST_INVALID");
  });
}
test("rejects absent required variables, undefined declarations, invalid defaults and wrong variable types", async () => {
  for (const query of [
    "query Page($n: Int!) { orders(first: $n) { id } }",
    "query Page { orders(first: $n) { id } }",
    "query Page($n: Int = 1.5) { orders(first: $n) { id } }",
    "query Page($n: String = \"10\") { orders(first: $n) { id } }",
  ]) expect(await code(await governGraphqlRequest(request({ query }), policy))).toBe("GRAPHQL_REQUEST_INVALID");
});
test("counts a fragment at every alias and depth, and rejects cycles and missing fragments", async () => {
  const query = "query Q { a { ...F } b { nested { ...F } } } fragment F on Item { id name }";
  expect(await governGraphqlRequest(request({ query }), policy)).toMatchObject({ fields: 7, complexity: 7, depth: 3 });
  expect(await code(await governGraphqlRequest(request({ query }), { ...policy, maxFields: 6 }))).toBe("GRAPHQL_OPERATION_BUDGET_EXCEEDED");
  expect(await code(await governGraphqlRequest(request({ query }), { ...policy, maxDepth: 2 }))).toBe("GRAPHQL_OPERATION_BUDGET_EXCEEDED");
  for (const query of ["query Q { ...F } fragment F on Query { ...F }", "query Q { ...Missing }"])
    expect(await code(await governGraphqlRequest(request({ query }), policy))).toBe("GRAPHQL_REQUEST_INVALID");
});
test("bounds fragment expansion even when the document is small", async () => {
  const fragments = Array.from({ length: 20 }, (_, index) => `fragment F${index} on Query { ${index === 19 ? "id" : `...F${index + 1} ...F${index + 1}`} }`).join(" ");
  expect(await code(await governGraphqlRequest(request({ query: `query Q { ...F0 } ${fragments}` }), policy))).toBe("GRAPHQL_OPERATION_BUDGET_EXCEEDED");
});
test("GET cannot bypass the allowlist, persisted envelope, or POST-only mutation rule", async () => {
  expect(await code(await governGraphqlRequest(request({ query: "query Other { id }" }, "GET"), { operations: ["Allowed"] }))).toBe("GRAPHQL_OPERATION_DENIED");
  expect(await code(await governGraphqlRequest(request({ query: "query Q { id }" }, "GET"), { persistedOnly: true }))).toBe("GRAPHQL_PERSISTED_OPERATION_REQUIRED");
  expect(await code(await governGraphqlRequest(request({ query: "mutation M { update }" }, "GET"), {}))).toBe("GRAPHQL_GET_MUTATION_DENIED");
});
test("keeps canonical persisted hashes compatible for selected operations and fragments", async () => {
  const query = "fragment F on Item { id } query Q { orders { ...F } } query Other { ignored }";
  const result = await governGraphqlRequest(request({ query, operationName: "Q" }), policy);
  expect(result).toMatchObject({ sha256: createHash("sha256").update(print(separateOperations(parse(query)).Q!)).digest("hex") });
});
test("bounds UTF-8 request bytes and rejects malformed variable envelopes", async () => {
  expect(await code(await governGraphqlRequest(request({ query: "query Q { id }", padding: "中".repeat(180_000) }), policy))).toBe("GRAPHQL_REQUEST_TOO_LARGE");
  for (const variables of [[], "{}", false]) {
    expect(await code(await governGraphqlRequest(request({ query: "query Q { id }", variables }), policy))).toBe("GRAPHQL_REQUEST_INVALID");
  }
});
test("policy failures are sanitized and never become disabled governance", async () => {
  const input = request({ query: "query Q { id }" });
  const failed = await governGraphqlProjectRequest(input, async () => { throw new Error("postgres://private:secret@host/db"); });
  expect((failed as Response).status).toBe(503);
  expect(await (failed as Response).json()).toEqual({ code: "GRAPHQL_POLICY_UNAVAILABLE", error: "GraphQL policy is unavailable" });
  for (const config of ["broken", [], { graphql_governance: { enabled: "true" } }, { graphql_governance: { enabled: true, operations: [123] } }]) {
    expect(await code(await governGraphqlProjectRequest(input, async () => config))).toBe("GRAPHQL_POLICY_UNAVAILABLE");
  }
  expect(await governGraphqlProjectRequest(input, async () => ({}))).toMatchObject({ fields: 0 });
  expect(await governGraphqlProjectRequest(new Request("http://localhost/graphql", { method: "OPTIONS" }), async () => { throw new Error("unavailable"); })).toMatchObject({ fields: 0 });
  expect(normalizeGraphqlRequestGovernancePolicy(undefined)).toEqual({ enabled: false });
});
