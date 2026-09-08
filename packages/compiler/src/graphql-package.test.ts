import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as ts from "@typescript/typescript6";
import { writeFixtureProject } from "./fixtures/helpers";

const temporary: string[] = [];
const consumerOptions = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  noFallthroughCasesInSwitch: true,
  skipLibCheck: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
} satisfies ts.CompilerOptions;

const scenarios = [
  {
    name: "scalar variables",
    schema: "",
    arguments: "id: ID!",
    variables: "$id: ID!",
    call: "id: $id",
    valid: '{ id: "42" }',
    invalid: "{ id: 42 }",
    declarations: [],
  },
  {
    name: "shared input and output enums",
    schema: "enum Status { OPEN CLOSED }",
    arguments: "status: Status!",
    variables: "$status: Status! = OPEN",
    call: "status: $status",
    valid: '{ status: "OPEN" }',
    invalid: '{ status: "INVALID" }',
    declarations: ["Status"],
  },
  {
    name: "recursive input objects with enum lists and defaults",
    schema: `
enum Status { OPEN CLOSED }
input IdFilter { eq: ID! }
input OrderFilter {
  id: IdFilter!
  statuses: [Status!] = [OPEN]
  and: [OrderFilter!]
  minimum: BigInt
}`,
    arguments: "filter: OrderFilter!",
    variables: "$filter: OrderFilter!",
    call: "filter: $filter",
    valid: '{ filter: { id: { eq: "42" }, statuses: ["OPEN"], and: [{ id: { eq: "43" } }], minimum: "100" } }',
    invalid: '{ filter: { id: { eq: 42 }, statuses: ["INVALID"], minimum: 100 } }',
    declarations: ["Status", "IdFilter", "OrderFilter"],
  },
] as const;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function diagnostics(path: string): string[] {
  const program = ts.createProgram([path], consumerOptions);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("GraphQL compiler consumer acceptance", () => {
  for (const artifact of ["SDK", "TypedDocumentNode"] as const) {
    test.each([...scenarios])(`${artifact}: $name compiles without duplicate declarations`, async (scenario) => {
      const cli = process.env["SUPACLOUD_COMPILER_TEST_CLI"] ?? join(import.meta.dir, "cli.ts");
      if (!isAbsolute(cli)) throw new Error("SUPACLOUD_COMPILER_TEST_CLI must be an absolute CLI entry point");
      const directory = await mkdtemp(join(tmpdir(), "supacloud-graphql-package-"));
      temporary.push(directory);
      const hasStatus = scenario.declarations.some((name) => name === "Status");
      const fields = `id total${hasStatus ? " status" : ""}`;
      await writeFixtureProject(directory, {
        "src/main.ts": "export const application = true;",
        "schema.graphql": `
scalar BigInt
${scenario.schema}
type Order { id: ID!, total: BigInt!, internal: String${hasStatus ? ", status: Status!" : ""} }
type Query { orders(${scenario.arguments}): [Order!]! }
`,
        "src/orders.graphql": `
query Orders(${scenario.variables}) { orders(${scenario.call}) { ...OrderFields } }
fragment OrderFields on Order { ${fields} }
`,
        "src/other.graphql": `query Other(${scenario.variables}) { orders(${scenario.call}) { ${fields} } }`,
        "supacloud.config.mjs": `export default {
  graphql: { schema: "schema.graphql", typedDocuments: ${artifact === "TypedDocumentNode"}, scalars: { BigInt: "string" } },
};`,
      });
      await symlink(join(import.meta.dir, "../node_modules"), join(directory, "node_modules"), "dir");
      const child = Bun.spawn([process.execPath, "--no-env-file", cli, "compile", "--json"], {
        cwd: directory, stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ status, stderr }, stdout).toEqual({ status: 0, stderr: "" });

      const output = join(directory, "generated");
      const filename = artifact === "SDK" ? "graphql.ts" : "graphql.documents.ts";
      const generated = await readFile(join(output, filename), "utf8");
      const prelude = artifact === "SDK"
        ? `import { createGraphqlClient } from "./graphql";
type Client = ReturnType<typeof createGraphqlClient>;
type Variables = Parameters<Client["Orders"]>[0];
type Result = Awaited<ReturnType<Client["Orders"]>>;`
        : `import { OrdersDocument } from "./graphql.documents";
import type { ResultOf, VariablesOf } from "@graphql-typed-document-node/core";
type Variables = VariablesOf<typeof OrdersDocument>;
type Result = ResultOf<typeof OrdersDocument>;`;
      const validConsumer = join(output, "consumer.ts");
      await writeFile(validConsumer, `${prelude}
const variables: Variables = ${scenario.valid};
declare const result: Result;
const id: string | undefined = result.orders[0]?.id;
const total: string | undefined = result.orders[0]?.total;
${hasStatus ? 'const status: "OPEN" | "CLOSED" | undefined = result.orders[0]?.status;' : ""}
`);
      expect(diagnostics(validConsumer)).toEqual([]);

      const source = ts.createSourceFile(filename, generated, ts.ScriptTarget.Latest, true);
      const declarations = source.statements.flatMap((statement) =>
        ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)
          ? [statement.name.text] : []);
      expect(declarations.filter((name, index) => declarations.indexOf(name) !== index)).toEqual([]);
      for (const name of scenario.declarations) {
        expect(declarations.filter((declaration) => declaration === name)).toHaveLength(1);
      }

      const invalidConsumer = join(output, "invalid-consumer.ts");
      await writeFile(invalidConsumer, `${prelude}
const variables: Variables = ${scenario.invalid};
declare const result: Result;
result.orders[0]?.internal;
`);
      const rejected = diagnostics(invalidConsumer);
      expect(rejected.some((message) => message.includes("is not assignable to type"))).toBe(true);
      expect(rejected.some((message) => message.includes("Property 'internal' does not exist"))).toBe(true);
    }, 20_000);
  }
});
