import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileOptionsFromConfig, defineSupacloudConfig } from "./config";
import { compileProject, checkProject } from "./compile";
import { assertGraphqlOptions } from "./graphql-options";
import { graphqlInputPaths } from "./graphql-inputs";
import { createIncrementalCompiler } from "./incremental";
import { writeFixtureProject } from "./fixtures/helpers";
import type { CompileOptions, GraphqlOptions } from "./types";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test.each(["schema.graphql", "graphql/schema.gql", "../graphql/schema.json", "/workspace/schema.graphql", "C:\\app\\schema.json"])(
  "accepts local snapshot format %s without introducing a schema mode",
  (schema) => {
    expect(() => assertGraphqlOptions({
      schema, documents: ["**/*.graphql"], typedDocuments: true,
      scalars: { BigInt: { input: "string", output: "string" }, JSON: "unknown" },
    })).not.toThrow();
  },
);

test.each([
  { schema: "schema.graphql", mode: "code-first" },
  { schema: "schema.graphql", mode: "schema-first" },
  { schema: "schema.graphql", autoSchemaFile: true },
  { schema: "schema.graphql", typePaths: ["**/*.graphql"] },
  { schema: "schema.graphql", resolvers: {} },
  { schema: "https://example.test/schema.graphql" },
  { schema: " https://example.test/schema.graphql" },
  { schema: "file:///workspace/schema.json" },
  { schema: "data:application/json,schema.json" },
  { schema: "schema.ts" },
  { schema: "schema.js" },
  { schema: "type Query { health: String! }" },
  { schema: "" },
  {},
  { schema: ["schema.graphql"] },
  { schema: "schema.graphql", documents: "**/*.graphql" },
  { schema: "schema.graphql", documents: [null] },
  { schema: "schema.graphql", typedDocuments: "true" },
  { schema: "schema.graphql", scalars: [] },
  { schema: "schema.graphql", scalars: { JSON: null } },
  { schema: "schema.graphql", scalars: { JSON: { input: "unknown" } } },
  null,
  true,
])("rejects unsupported database-first configuration %j before path resolution", (graphql) => {
  expect(() => assertGraphqlOptions(graphql)).toThrow("Database First only");
  expect(() => defineSupacloudConfig({ graphql: graphql as GraphqlOptions })).toThrow("Database First only");
  expect(() => compileOptionsFromConfig({ graphql: graphql as GraphqlOptions }, "/workspace")).toThrow("Database First only");
});

test("compile, check and incremental calls reject alternative modes and preserve working artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graphql-options-"));
  temporary.push(directory);
  await writeFixtureProject(directory, {
    "src/main.ts": "export const application = true;",
    "src/health.graphql": "query Health { health }",
    "graphql/schema.graphql": "type Query { health: String! }",
  });
  const options = compileOptionsFromConfig({ graphql: { schema: "graphql/schema.graphql" }, strict: false }, directory);
  expect((await compileProject(options)).diagnostics).toEqual([]);
  const clientPath = join(options.outDir, "graphql.ts");
  const original = await readFile(clientPath, "utf8");
  const invalid: CompileOptions = {
    ...options,
    graphql: { ...options.graphql!, autoSchemaFile: true } as GraphqlOptions,
  };
  expect(graphqlInputPaths(invalid)).toEqual([]);
  const incremental = createIncrementalCompiler();
  for (const result of [
    await compileProject(invalid),
    await checkProject(invalid),
    await incremental.compile(invalid),
  ]) {
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "graphql-config-invalid", severity: "error",
    }));
    if ("written" in result) expect(result.written).toEqual([]);
    expect(await readFile(clientPath, "utf8")).toBe(original);
  }
});

test("CLI rejects alternative schema modes with a machine-readable diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "graphql-mode-cli-"));
  temporary.push(directory);
  await writeFile(join(directory, "supacloud.config.mjs"),
    'export default { graphql: { schema: "schema.graphql", mode: "code-first" } };');
  for (const command of ["compile", "check", "dev", "graphql-schema"]) {
    const child = Bun.spawn([
      process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), command, "--json",
    ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false, written: [],
      diagnostics: [{ code: "graphql-config-invalid", severity: "error" }],
    });
  }
}, 20_000);
