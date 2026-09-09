import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { compileProject, checkProject } from "./compile";
import { compileOptionsFromConfig } from "./config";
import { renderGraphql } from "./graphql";
import { renderGraphqlValidators } from "./graphql-runtime";
import { writeFixtureProject } from "./fixtures/helpers";
import type { CompileOptions, GraphqlOptions } from "./types";

const schema = `
scalar Amount
enum State { OPEN CLOSED }
input Filter { state: State, limit: Int }
interface Node { id: ID! }
type Order implements Node {
  id: ID!
  title: String!
  state: State!
  total: Amount
  lines: [[String!]!]!
  count: Int!
  score: Float!
  active: Boolean!
}
type User implements Node { id: ID!, name: String! }
union SearchResult = Order | User
type Query {
  order(filter: Filter): Order
  search: [SearchResult!]!
  node: Node
}
`;
const documents = `
fragment OrderFields on Order { key: id title state total lines count score active }
query Detail($withTitle: Boolean! = true, $filter: Filter) {
  record: order(filter: $filter) {
    ...OrderFields
    conditional: title @include(if: $withTitle)
  }
  results: search {
    __typename
    ... on Order { ...OrderFields }
    ... on User { id name }
  }
  node {
    __typename
    id
    ... on Order { title }
    ... on User { name }
  }
}
query List { results: search { ... on Order { id } ... on User { name } } }
`;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(scalars: GraphqlOptions["scalars"] = { Amount: "string" }): Promise<CompileOptions> {
  const directory = await mkdtemp(join(tmpdir(), "graphql-runtime-"));
  temporary.push(directory);
  await writeFixtureProject(directory, {
    "src/main.ts": "export const application = true;",
    "src/catalog.graphql": documents,
    "schema.graphql": schema,
  });
  return compileOptionsFromConfig({
    strict: false,
    graphql: { schema: "schema.graphql", ...(scalars === undefined ? {} : { scalars }) },
  }, directory);
}

async function moduleFixture(scalars: GraphqlOptions["scalars"] = { Amount: "string" }) {
  const options = await fixture(scalars);
  const result = await renderGraphql(options);
  expect(result.diagnostics).toEqual([]);
  const source = result.files["graphql.ts"];
  if (source === undefined) throw new Error("Missing generated GraphQL client");
  const path = join(options.outDir, "graphql.ts");
  await writeFixtureProject(options.outDir, { "graphql.ts": source });
  // Import into unknown and validate the callable boundary; tests inspect unknown
  // results instead of asserting a handwritten duplicate of the generated SDK.
  const loaded: unknown = await import(pathToFileURL(path).href);
  if (!loaded || typeof loaded !== "object"
    || !("parseDetailQuery" in loaded) || typeof loaded.parseDetailQuery !== "function"
    || !("isDetailQuery" in loaded) || typeof loaded.isDetailQuery !== "function"
    || !("parseGraphqlResult" in loaded) || typeof loaded.parseGraphqlResult !== "function"
    || !("isGraphqlResult" in loaded) || typeof loaded.isGraphqlResult !== "function"
    || !("getSdk" in loaded) || typeof loaded.getSdk !== "function"
    || !("createGraphqlClient" in loaded) || typeof loaded.createGraphqlClient !== "function") {
    throw new Error("Missing generated public validators or SDK");
  }
  const { parseDetailQuery, isDetailQuery, parseGraphqlResult, isGraphqlResult, getSdk, createGraphqlClient } = loaded;
  return {
    options, source,
    module: {
      parseDetailQuery: (value: unknown): unknown => parseDetailQuery(value),
      isDetailQuery: (value: unknown): unknown => isDetailQuery(value),
      parseGraphqlResult: (name: string, value: unknown): unknown => parseGraphqlResult(name, value),
      isGraphqlResult: (name: string, value: unknown): unknown => isGraphqlResult(name, value),
      getSdk: (requester: () => Promise<unknown>): unknown => getSdk(requester),
      createGraphqlClient: (options: { url: string; fetch: () => Promise<Response> }): unknown => createGraphqlClient(options),
    },
  };
}

function validResult() {
  const order = { key: "o1", title: "Order", state: "OPEN", total: "123", lines: [["line"]], count: 1, score: 2.5, active: true };
  return {
    record: order,
    results: [{ __typename: "Order", ...order }, { __typename: "User", id: "u1", name: "User" }],
    node: { __typename: "User", id: "u1", name: "User" },
  };
}

function detailMethod(value: unknown): (variables?: unknown) => Promise<unknown> {
  if (!value || typeof value !== "object" || !("Detail" in value) || typeof value.Detail !== "function") {
    throw new Error("Generated SDK is missing Detail");
  }
  const method = value.Detail;
  return async (variables) => {
    const result: unknown = await method(variables);
    return result;
  };
}

describe("GraphQL result validation", () => {
  test("validates aliases, fragments, nullable relations, conditional fields and abstract types", async () => {
    const { module } = await moduleFixture();
    const result = validResult();
    expect(module.parseDetailQuery(result)).toBe(result);
    expect(module.isDetailQuery(result)).toBe(true);
    expect(module.parseGraphqlResult("Detail", result)).toBe(result);
    expect(module.isGraphqlResult("Detail", result)).toBe(true);
    expect(module.isGraphqlResult("UnknownOperation", result)).toBe(false);
    expect(() => module.parseGraphqlResult("UnknownOperation", result)).toThrow("GraphQL result does not match operation UnknownOperation.");
    expect(module.isDetailQuery({ record: null, results: [], node: null })).toBe(true);
    expect(module.isDetailQuery({
      ...result,
      record: { ...result.record, conditional: "included" },
      node: { __typename: "Order", id: "o1", title: "Order" },
    })).toBe(true);
    expect(module.isDetailQuery({ ...result, extra: "ignored" })).toBe(true);
  });

  test("rejects wrong selected values, missing keys, enum members, union branches and list items", async () => {
    const { module } = await moduleFixture();
    const result = validResult();
    const invalid: unknown[] = [
      null, [], {}, { record: null, results: [] },
      { ...result, record: {} },
      { ...result, record: { ...result.record, key: 1 } },
      { ...result, record: { ...result.record, title: null } },
      { ...result, record: { ...result.record, state: "UNKNOWN" } },
      { ...result, record: { ...result.record, total: 123 } },
      { ...result, record: { ...result.record, conditional: false } },
      { ...result, record: { ...result.record, conditional: undefined } },
      { ...result, record: { ...result.record, lines: [[null]] } },
      { ...result, record: { ...result.record, lines: [new Array(1)] } },
      { ...result, record: { ...result.record, count: "1" } },
      { ...result, record: { ...result.record, score: Number.NaN } },
      { ...result, record: { ...result.record, score: Number.POSITIVE_INFINITY } },
      { ...result, record: { ...result.record, active: 1 } },
      { ...result, results: [null] },
      { ...result, results: [{ __typename: "User", ...result.record }] },
      { ...result, results: [{ __typename: "Other", id: "u1", name: "User" }] },
      { ...result, node: { __typename: "User", id: "u1" } },
      { ...result, node: { __typename: "Order", id: "o1", name: "wrong branch" } },
      Object.create(result),
    ];
    for (const value of invalid) {
      expect(module.isDetailQuery(value)).toBe(false);
      expect(() => module.parseDetailQuery(value)).toThrow("GraphQL result does not match Detail.");
    }
  });

  test("both the built-in client and custom requesters reject invalid results without leaking values", async () => {
    const { module } = await moduleFixture();
    const invalid = { ...validResult(), record: { title: "private-response-value" } };
    const sdk: unknown = module.getSdk(async () => invalid);
    await expect(detailMethod(sdk)()).rejects.toMatchObject({
      name: "GraphqlRequestError",
      code: "invalid-response",
      message: "GraphQL result does not match Detail.",
    });
    const client: unknown = module.createGraphqlClient({
      url: "https://example.test",
      fetch: async () => Response.json({ data: invalid }),
    });
    await expect(detailMethod(client)()).rejects.toMatchObject({ code: "invalid-response" });
    const valid = validResult();
    const custom: unknown = module.getSdk(async () => valid);
    expect(await detailMethod(custom)()).toBe(valid);
  });

  test("unknown scalars stay unknown but the selected property is still required", async () => {
    const options = await fixture({});
    const { files, diagnostics } = await renderGraphql(options);
    expect(diagnostics).toEqual([]);
    const source = files["graphql.ts"];
    if (source === undefined) throw new Error("Missing client");
    const path = join(options.outDir, "graphql.ts");
    await writeFixtureProject(options.outDir, { "graphql.ts": source });
    const module: unknown = await import(pathToFileURL(path).href);
    if (!module || typeof module !== "object" || !("isDetailQuery" in module)
      || typeof module.isDetailQuery !== "function") throw new Error("Missing validator");
    const result = validResult();
    expect(module.isDetailQuery({ ...result, record: { ...result.record, total: { custom: 123 } } })).toBe(true);
    const { total: _total, ...withoutTotal } = result.record;
    expect(module.isDetailQuery({ ...result, record: withoutTotal })).toBe(false);
  });

  test("JSON record scalar mappings validate values without customer schemas", async () => {
    const { module } = await moduleFixture({ Amount: "Record<string, string>" });
    const result = { record: { ...validResult().record, total: { currency: "USD" } }, results: [], node: null };
    expect(module.isDetailQuery(result)).toBe(true);
    expect(module.isDetailQuery({ ...result, record: { ...result.record, total: { currency: 1 } } })).toBe(false);
  });

  test("public parsers narrow unknown with all strict consumer checks and no runtime imports", async () => {
    const { options, source } = await moduleFixture();
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toContain(" as R");
    await writeFile(join(options.outDir, "consumer.ts"), `
import { getSdk, isDetailQuery, parseDetailQuery, parseGraphqlResult, type GraphqlQueryResults, type DetailQuery } from "./graphql";
const wire: unknown = JSON.parse("{}");
const result: DetailQuery = parseDetailQuery(wire);
if (isDetailQuery(wire)) {
  const title: string | undefined = wire.record?.title;
}
const sdk = getSdk(async (_query, _variables, _options: { signal?: AbortSignal } | undefined): Promise<unknown> => wire);
const typed: DetailQuery = await sdk.Detail({}, {});
const id: string | undefined = result.record?.key;
const byName: DetailQuery = parseGraphqlResult("Detail", wire);
function decode<Name extends keyof GraphqlQueryResults>(name: Name, value: unknown): GraphqlQueryResults[Name] {
  return parseGraphqlResult(name, value);
}
const generic: DetailQuery = decode("Detail", wire);
`);
    const program = ts.createProgram([join(options.outDir, "consumer.ts")], {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      noImplicitOverride: true, noPropertyAccessFromIndexSignature: true, noFallthroughCasesInSwitch: true,
      skipLibCheck: false, noEmit: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  });

  test("TypedDocumentNode output shares enum and input types without duplicate declarations", async () => {
    const options = await fixture();
    const graphql = options.graphql;
    if (!graphql) throw new Error("Missing GraphQL options");
    const result = await compileProject({ ...options, graphql: { ...graphql, typedDocuments: true } });
    expect(result.diagnostics).toEqual([]);
    await symlink(join(import.meta.dir, "../node_modules"), join(options.outDir, "node_modules"), "dir");
    const path = join(options.outDir, "graphql.documents.ts");
    const source = await readFile(path, "utf8");
    expect(source.match(/export type State =/g)).toHaveLength(1);
    expect(source.match(/export type Filter =/g)).toHaveLength(1);
    const program = ts.createProgram([path], {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      noImplicitOverride: true, noPropertyAccessFromIndexSignature: true, noFallthroughCasesInSwitch: true,
      skipLibCheck: false, noEmit: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  });

  test("generated validators participate in drift checks and invalid mappings preserve successful artifacts", async () => {
    const options = await fixture();
    expect((await compileProject(options)).diagnostics).toEqual([]);
    const path = join(options.outDir, "graphql.ts");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("Number.isFinite", "Number.isNaN") + "\n// drift\n");
    expect((await checkProject(options)).mismatches).toContain("graphql.ts: disk artifact differs from current compiler output");
    expect((await compileProject(options)).diagnostics).toEqual([]);
    const graphql = options.graphql;
    if (!graphql) throw new Error("Missing GraphQL options");
    const failed = await compileProject({ ...options, graphql: { ...graphql, scalars: { Amount: "Date" } } });
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ code: "graphql-generation-failed", severity: "error" }));
    expect(failed.written).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

test.each(["any", "Date", "() => string", "[string, ...number[]]", "Record<number, string>"])(
  "validator generation refuses unsafe or unrepresentable result type %s", (type) => {
    expect(() => renderGraphqlValidators(`export type UnsafeQuery = ${type};`, ["Unsafe"])).toThrow("Unsupported GraphQL result wire type");
  },
);

test("validator generation reports missing or invalid operation types", () => {
  expect(() => renderGraphqlValidators("export type Other = string;", ["Missing"])).toThrow("Missing generated operation type");
  expect(() => renderGraphqlValidators("export type BadQuery = Missing;", ["Bad"])).toThrow("Generated GraphQL types cannot be validated");
  expect(() => renderGraphqlValidators(
    "export type GraphqlQueryResults = string; export type ValidQuery = string;", ["Valid"],
  )).toThrow("conflicts with the generated result registry");
});
