import { expect, test } from "bun:test";
import { renderGraphqlValidators } from "./graphql-runtime";

test("GraphQL validators resolve the virtual source using native path separators", () => {
  const validators = renderGraphqlValidators(
    'export type PingQuery = { __typename?: "Query"; ping: string };',
    ["Ping"],
  );
  expect(validators).toContain("export function parsePingQuery");
  expect(validators).toContain('typeof value === "string"');
});
