import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "@typescript/typescript6";
import { buildSchema, introspectionFromSchema } from "graphql";
import { compileProject, checkProject } from "./compile";
import { compileOptionsFromConfig } from "./config";
import { createIncrementalCompiler } from "./incremental";
import { renderGraphql } from "./graphql";
import { scanGeneratedArtifacts } from "./type-safety";
import { writeFixtureProject } from "./fixtures/helpers";
import type { CompileOptions, WatchHandle } from "./types";
import { watchProject } from "./watch";
import { createContextPack } from "./inspect";

const SCHEMA = `
scalar BigInt
type Order { id: ID!, title: String!, total: BigInt, internal: String }
type Query { order(id: ID!): Order, orders: [Order!]! }
type Mutation { deleteOrder(id: ID!): Boolean! }
type Subscription { orders: Order! }
`;
const QUERY = `query OrderDetail($id: ID!) {
  order(id: $id) { ...OrderFields }
}
`;
const FRAGMENT = `fragment OrderFields on Order { id title total }`;
const temporary: string[] = [];
let watcher: WatchHandle | undefined;

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<CompileOptions> {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-graphql-"));
  temporary.push(directory);
  await writeFixtureProject(directory, {
    "src/main.ts": "export const application = true;",
    "src/order.graphql": QUERY,
    "src/fragments.gql": FRAGMENT,
    "graphql/schema.graphql": SCHEMA,
  });
  return compileOptionsFromConfig({
    graphql: { schema: "graphql/schema.graphql" },
    strict: false,
  }, directory);
}

describe("GraphQL query contracts", () => {
  test.each([undefined, false] as const)("unconfigured/disabled projects compile without a schema (%s)", async (graphql) => {
    const configured = await fixture();
    const directory = dirname(configured.rootDir);
    await rm(configured.graphql!.schema);
    const options = compileOptionsFromConfig({ graphql }, directory);
    expect(options.graphql).toBeUndefined();
    const result = await compileProject(options);
    expect(result.diagnostics).toEqual([]);
    expect(result.graph.graphql).toBeUndefined();
    expect(result.written).not.toContain(join(options.outDir, "graphql.ts"));
    await expect(access(join(options.outDir, "graphql.ts"))).rejects.toThrow();
    const checked = await checkProject(options);
    expect(checked.upToDate).toBe(true);
    expect(checked.diagnostics).toEqual([]);
  });

  test.each([false, true])("adopted query contracts fail closed with strict=%s", async (strict) => {
    const options = { ...await fixture(), strict };
    expect((await compileProject(options)).diagnostics).toEqual([]);
    const original = await readFile(join(options.outDir, "graphql.ts"), "utf8");
    for (const query of ["query Broken { orders { missing } }", 'mutation Delete { deleteOrder(id: "42") }']) {
      await writeFile(join(options.rootDir, "order.graphql"), query);
      const compiled = await compileProject(options);
      expect(compiled.diagnostics.some((diagnostic) =>
        diagnostic.severity === "error" && diagnostic.code.startsWith("graphql-"))).toBe(true);
      expect(compiled.written).toEqual([]);
      const checked = await checkProject(options);
      expect(checked.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
      expect(await readFile(join(options.outDir, "graphql.ts"), "utf8")).toBe(original);
    }
    await rm(options.graphql!.schema);
    expect((await compileProject(options)).diagnostics.some((diagnostic) =>
      diagnostic.code === "graphql-schema-invalid" && diagnostic.severity === "error")).toBe(true);
  });

  test("CLI keeps legacy compilation optional and rejects configured invalid contracts in JSON mode", async () => {
    const configured = await fixture();
    const directory = dirname(configured.rootDir);
    await rm(configured.graphql!.schema);
    const run = async (command: string, ...flags: string[]) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), command, "--json", ...flags], {
        cwd: directory, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      return { status, result: JSON.parse(stdout) as { ok: boolean; diagnostics: Array<{ code: string; severity: string }> } };
    };
    expect(await run("compile")).toMatchObject({ status: 0, result: { ok: true, diagnostics: [] } });
    expect(await run("check")).toMatchObject({ status: 0, result: { ok: true, diagnostics: [] } });
    await writeFile(join(directory, "supacloud.config.mjs"),
      'export default { graphql: { schema: "graphql/schema.graphql" } };');
    const failed = await run("compile", "--no-strict");
    expect(failed.status).toBe(1);
    expect(failed.result.ok).toBe(false);
    expect(failed.result.diagnostics).toContainEqual(expect.objectContaining({
      code: "graphql-schema-invalid", severity: "error",
    }));
  }, 20_000);

  test("resolves schema relative to configuration and queries relative to root; low-level API remains optional", async () => {
    const options = await fixture();
    expect(options.graphql?.schema).toBe(join(options.rootDir, "../graphql/schema.graphql"));
    expect(await renderGraphql({ ...options, graphql: undefined })).toEqual({ diagnostics: [], files: {} });
    const result = await renderGraphql(options);
    expect(result.diagnostics).toEqual([]);
    expect(result.files["graphql.ts"]).toContain("OrderDetailQueryVariables");
    expect(result.files["graphql.ts"]).toContain("createGraphqlClient");
    expect(result.files["graphql.ts"]).not.toMatch(/^import /m);
    expect(result.files["graphql.ts"]).toContain("unknown");
    expect(scanGeneratedArtifacts({ "graphql.ts": result.files["graphql.ts"] }, true)).toEqual([]);
    expect(JSON.parse(result.files["graphql.manifest.json"]!)).toMatchObject({
      mode: "query-only",
      operations: [{ name: "OrderDetail", file: "order.graphql", line: 1 }],
    });
    expect((await renderGraphql(options)).files).toEqual(result.files);
  });

  test("generated consumer types reject missing/wrong variables and unselected fields", async () => {
    const options = await fixture();
    const { files, diagnostics } = await renderGraphql(options);
    expect(diagnostics).toEqual([]);
    await writeFixtureProject(options.outDir, {
      "graphql.ts": files["graphql.ts"]!,
      "consumer.ts": `
import { createGraphqlClient } from "./graphql";
const queries = createGraphqlClient({ url: "https://example.test" });
const result = await queries.OrderDetail({ id: "42" });
const title: string | undefined = result.order?.title;
// @ts-expect-error ID is a string
queries.OrderDetail({ id: 42 });
// @ts-expect-error required variables cannot be omitted
queries.OrderDetail();
// @ts-expect-error unselected fields are absent from the result type
result.order?.internal;
// @ts-expect-error nullable relationship must be handled
result.order.title;
// @ts-expect-error custom scalars require explicit mapping or narrowing
const total: number = result.order!.total;
`,
    });
    const program = ts.createProgram([join(options.outDir, "consumer.ts")], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  test("optional TypedDocumentNode artifacts infer consumer results and participate in drift checks", async () => {
    const options = await fixture();
    options.graphql!.typedDocuments = true;
    const result = await compileProject(options);
    expect(result.diagnostics).toEqual([]);
    const documentPath = join(options.outDir, "graphql.documents.ts");
    expect(result.written).toContain(documentPath);
    const content = await readFile(documentPath, "utf8");
    expect(content).toContain("@graphql-typed-document-node/core");
    expect(content).toContain("OrderDetailDocument");
    await symlink(join(import.meta.dir, "../node_modules"), join(dirname(options.rootDir), "node_modules"), "dir");
    await writeFixtureProject(options.outDir, {
      "typed-consumer.ts": `
import { OrderDetailDocument } from "./graphql.documents";
import type { ResultOf, VariablesOf } from "@graphql-typed-document-node/core";
const variables: VariablesOf<typeof OrderDetailDocument> = { id: "42" };
// @ts-expect-error required ID cannot be numeric
const invalidVariables: VariablesOf<typeof OrderDetailDocument> = { id: 42 };
declare const result: ResultOf<typeof OrderDetailDocument>;
const title: string | undefined = result.order?.title;
// @ts-expect-error this field was not selected by the operation
result.order?.internal;
`,
    });
    const program = ts.createProgram([join(options.outDir, "typed-consumer.ts")], {
      strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [],
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    expect((await checkProject(options)).upToDate).toBe(true);
    await writeFile(documentPath, content + "\n// drift\n");
    expect((await checkProject(options)).mismatches).toContain("graphql.documents.ts: disk artifact differs from current compiler output");
  });

  test.each([
    ["missing field", "query Missing { orders { nonexistent } }", "graphql-validation"],
    ["variable type", "query Wrong($id: Int!) { order(id: $id) { id } }", "graphql-validation"],
    ["anonymous", "{ orders { id } }", "graphql-operation-name-required"],
    ["mutation", "mutation Delete { deleteOrder(id: \"42\") }", "graphql-query-only"],
    ["subscription", "subscription Live { orders { id } }", "graphql-query-only"],
    ["syntax", "query Bad {", "graphql-document-invalid"],
    ["fragment cycle", "query Cycle { orders { ...Loop } } fragment Loop on Order { ...Loop }", "graphql-validation"],
    ["duplicate", "query Dup { orders { id } } query Dup { orders { title } }", "graphql-validation"],
    ["schema definition", "type Foo { id: ID }", "graphql-document-invalid"],
  ])("rejects %s with a source location", async (_name, query, code) => {
    const options = await fixture();
    await writeFile(join(options.rootDir, "order.graphql"), query);
    const result = await renderGraphql(options);
    const error = result.diagnostics.find((d) => d.code === code);
    expect(error?.severity).toBe("error");
    expect(error?.file).toBe("order.graphql");
    expect(error?.line).toBeGreaterThan(0);
    expect(result.files).toEqual({});
  });

  test("supports introspection JSON snapshots and explicit scalar mapping", async () => {
    const options = await fixture();
    const schema = options.graphql!.schema.replace(".graphql", ".json");
    await writeFile(schema, JSON.stringify({ data: introspectionFromSchema(buildSchema(SCHEMA)) }));
    options.graphql = { schema, scalars: { BigInt: "string" } };
    const result = await renderGraphql(options);
    expect(result.diagnostics).toEqual([]);
    expect(result.files["graphql.ts"]).toContain("total: string | null");
  });

  test("missing/broken schema and empty document inventory are structured failures", async () => {
    const options = await fixture();
    await writeFile(options.graphql!.schema, "type Broken {");
    expect((await renderGraphql(options)).diagnostics[0]?.code).toBe("graphql-schema-invalid");
    await rm(options.graphql!.schema);
    expect((await renderGraphql(options)).diagnostics[0]?.code).toBe("graphql-schema-invalid");
    await writeFile(options.graphql!.schema, SCHEMA);
    options.graphql!.documents = ["nothing/*.graphql"];
    expect((await renderGraphql(options)).diagnostics[0]?.code).toBe("graphql-documents-missing");
  });

  test("compile/check include artifacts, reject drift and preserve working output on errors", async () => {
    const options = await fixture();
    const compiled = await compileProject(options);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.written).toContain(join(options.outDir, "graphql.ts"));
    expect((await checkProject(options)).upToDate).toBe(true);
    const original = await readFile(join(options.outDir, "graphql.ts"), "utf8");
    await writeFile(join(options.rootDir, "fragments.gql"), FRAGMENT.replace("id title total", "id title"));
    expect((await checkProject(options)).mismatches).toContain("graphql.ts: disk artifact differs from current compiler output");
    await writeFile(join(options.rootDir, "order.graphql"), "query Bad { missing }");
    const failed = await compileProject(options);
    expect(failed.diagnostics.some((d) => d.code === "graphql-validation")).toBe(true);
    expect(failed.written).toEqual([]);
    expect(await readFile(join(options.outDir, "graphql.ts"), "utf8")).toBe(original);
  });

  test("context packs keep colocated query diagnostics and do not claim unrelated queries", async () => {
    const options = await fixture();
    await writeFixtureProject(options.rootDir, {
      "reviews/order.graphql": QUERY,
      "other/other.graphql": "query Other { orders { id } }",
    });
    await rm(join(options.rootDir, "order.graphql"));
    const result = await checkProject(options);
    const graph = {
      ...result.graph,
      modules: [{
        name: "reviews", className: "ReviewsModule", file: "reviews/reviews.module.ts", line: 1,
        imports: [], providers: [], controllers: [], commands: [], queries: [], exports: [],
      }],
    };
    expect(createContextPack(graph, "reviews").graphql?.operations.map((operation) => operation.name)).toEqual(["OrderDetail"]);
    await writeFile(join(options.rootDir, "reviews/order.graphql"), "query Bad { missingField }");
    const failed = await checkProject(options);
    const pack = createContextPack({ ...graph, graphql: failed.graph.graphql, diagnostics: failed.diagnostics }, "reviews");
    expect(pack.diagnostics.some((d) => d.code === "graphql-validation" && d.file === "reviews/order.graphql")).toBe(true);
  });

  test("incremental snapshots cover schema, documents, deletions and option changes", async () => {
    const options = await fixture();
    const compiler = createIncrementalCompiler();
    expect((await compiler.compile(options)).diagnostics).toEqual([]);
    expect((await compiler.compile(options)).stats.cacheHit).toBe(true);
    await writeFile(join(options.rootDir, "fragments.gql"), FRAGMENT.replace("id title total", "id title"));
    expect((await compiler.compile(options, ["fragments.gql"])).stats.cacheHit).toBe(false);
    await writeFile(options.graphql!.schema, SCHEMA.replace("title: String!", "name: String!"));
    const changed = await compiler.compile(options, [options.graphql!.schema]);
    expect(changed.stats.cacheHit).toBe(false);
    expect(changed.diagnostics.some((d) => d.code === "graphql-validation")).toBe(true);
    await writeFile(options.graphql!.schema, SCHEMA);
    expect((await compiler.compile(options)).diagnostics).toEqual([]);
    await rm(join(options.rootDir, "fragments.gql"));
    expect((await compiler.compile(options)).diagnostics.some((d) => d.code === "graphql-validation")).toBe(true);
    await writeFile(join(options.rootDir, "fragments.gql"), FRAGMENT);
    options.graphql!.scalars = { BigInt: "string" };
    expect((await compiler.compile(options)).stats.cacheHit).toBe(false);
  });

  test("watch recompiles query documents and an external schema", async () => {
    const options = await fixture();
    const completed: Array<{ errors: string[] }> = [];
    watcher = watchProject({
      ...options,
      debounceMs: 10,
      onEvent(event) {
        if (!event.initial && event.type !== "compile-start") {
          completed.push({ errors: event.diagnostics.map((d) => d.code) });
        }
      },
    });
    expect((await watcher.ready).type).toBe("compiled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(options.rootDir, "fragments.gql"), FRAGMENT.replace("id title total", "id title"));
    await waitFor(() => completed.length > 0);
    expect(completed.at(-1)?.errors).toEqual([]);
    completed.length = 0;
    await writeFile(options.graphql!.schema, SCHEMA.replace("title: String!", "name: String!"));
    await waitFor(() => completed.some((event) => event.errors.includes("graphql-validation")));
  }, 20_000);
});

describe("generated GraphQL client", () => {
  async function clientModule() {
    const options = await fixture();
    const { files } = await renderGraphql(options);
    const path = join(options.rootDir, "client.ts");
    await writeFile(path, files["graphql.ts"]!);
    return import(pathToFileURL(path).href) as Promise<{
      createGraphqlClient(options: {
        url: string;
        publishableKey?: string;
        getAccessToken?: () => string | undefined | Promise<string | undefined>;
        fetch?: (url: string, init: RequestInit) => Promise<Response>;
      }): { OrderDetail(variables: { id: string }, options?: { signal: AbortSignal }): Promise<unknown> };
    }>;
  }

  test("uses current identity, isolated fragments, public key and cancellation without following redirects", async () => {
    const { createGraphqlClient } = await clientModule();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let token: string | undefined = "first";
    const queries = createGraphqlClient({
      url: "https://project.example.test/",
      publishableKey: "public-key",
      getAccessToken: async () => token,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ data: { order: { id: "42", title: "Order", total: null } } });
      },
    });
    const controller = new AbortController();
    await queries.OrderDetail({ id: "42" }, { signal: controller.signal });
    token = "refreshed";
    await queries.OrderDetail({ id: "42" });
    token = undefined;
    await queries.OrderDetail({ id: "42" });
    expect(requests.map(({ init }) => new Headers(init.headers).get("Authorization"))).toEqual([
      "Bearer first", "Bearer refreshed", null,
    ]);
    expect(requests[0]?.url).toBe("https://project.example.test/graphql/v1");
    expect(new Headers(requests[0]?.init.headers).get("apikey")).toBe("public-key");
    expect(requests[0]?.init.signal).toBe(controller.signal);
    expect(requests[0]?.init.redirect).toBe("error");
    const body = JSON.parse(String(requests[0]?.init.body));
    expect(body.variables).toEqual({ id: "42" });
    expect(body.query).toContain("query OrderDetail");
    expect(body.query).toContain("fragment OrderFields");
  });

  test.each([
    ["http", () => new Response("sensitive body", { status: 403 })],
    ["graphql", () => Response.json({ data: { order: null }, errors: [{ message: "denied" }] })],
    ["invalid-response", () => new Response("not JSON")],
    ["invalid-response", () => Response.json({ data: null })],
    ["invalid-response", () => Response.json({ data: [] })],
    ["invalid-response", () => Response.json({ errors: "bad" })],
    ["invalid-response", () => Response.json({ extensions: {} })],
  ])("rejects %s responses", async (code, response) => {
    const { createGraphqlClient } = await clientModule();
    const queries = createGraphqlClient({
      url: "https://project.example.test",
      fetch: async () => response(),
    });
    await expect(queries.OrderDetail({ id: "42" })).rejects.toMatchObject({
      name: "GraphqlRequestError", code,
    });
  });

  test("rejects insecure remote URLs and credential-bearing URLs", async () => {
    const { createGraphqlClient } = await clientModule();
    for (const url of ["http://remote.test", "https://user:secret@remote.test", "https://remote.test?token=secret"]) {
      expect(() => createGraphqlClient({ url })).toThrow();
    }
    expect(() => createGraphqlClient({ url: "http://127.0.0.1:54321" })).not.toThrow();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("GraphQL watch event timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
