import { describe, expect, test } from "bun:test";
import {
  checkGraphqlCompatibility,
  createRoleSnapshotReport,
  diffGraphqlSchemas,
  graphqlFeatureMatrix,
  schemaFromSource,
} from "./graphql-governance";

const base = `
  type Query {
    ordersCollection(first: Int, filter: String, orderBy: String): OrderConnection
    ordersByPk(id: ID!): Order
  }
  type Mutation { createOrder(id: ID!): Order }
  type OrderConnection { edges: [OrderEdge!]!, pageInfo: PageInfo! }
  type OrderEdge { node: Order }
  type PageInfo { hasNextPage: Boolean! }
  type Order { id: ID!, total: Int }
`;

test("reports pg_graphql-shaped capabilities and operation budgets", () => {
  const schema = schemaFromSource(base);
  expect(graphqlFeatureMatrix(schema)).toEqual({
    pgGraphql: "schema-snapshot",
    query: true,
    mutation: true,
    subscription: false,
    relayConnections: true,
    filtering: true,
    ordering: true,
    aggregation: false,
    byPk: true,
    functions: false,
  });
  const result = checkGraphqlCompatibility(schema, [{
    path: "orders.graphql",
    source: "query Orders { ordersCollection(first: 3) { edges { node { id total } } } }",
  }], { maxDepth: 5, maxFields: 10, maxComplexity: 10, maxPageSize: 5, operations: ["Orders"] });
  expect(result.ok).toBe(true);
  expect(result.operations[0]).toMatchObject({ name: "Orders", depth: 4, fields: 5, pageSizes: [3], allowed: true });
});

test("rejects disallowed, too-deep and over-sized operations", () => {
  const schema = schemaFromSource(base);
  const result = checkGraphqlCompatibility(schema, [{
    source: "query Secret { ordersCollection(first: 99) { edges { node { id } } } }",
  }], { operations: ["Orders"], maxDepth: 3, maxPageSize: 20 });
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item) => item.code)).toEqual([
    "graphql-page-size",
    "graphql-depth",
    "graphql-operation-denied",
  ]);
});

test("classifies removed fields as breaking and additions as compatible", () => {
  const previous = schemaFromSource("type Query { old: String! }");
  const current = schemaFromSource("type Query { newField: String! }");
  const result = diffGraphqlSchemas(previous, current);
  expect(result.ok).toBe(false);
  expect(result.breaking[0]?.code).toBe("field-removed");
  expect(result.nonBreaking[0]?.code).toBe("field-added");
});

test("builds a role snapshot report without treating roles as one schema", () => {
  const result = createRoleSnapshotReport([
    { role: "anon", path: "anon.graphql", source: "type Query { public: String }" },
    { role: "authenticated", path: "authenticated.graphql", source: "type Query { public: String, private: String }" },
  ]);
  expect(result.ok).toBe(true);
  expect(result.roles.map((role) => role.role)).toEqual(["anon", "authenticated"]);
  expect(result.roles[0]?.schemaHash).not.toBe(result.roles[1]?.schemaHash);
});
