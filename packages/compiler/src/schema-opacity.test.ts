import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { analyzeProject } from "./analyze";
import { validateRouteContracts } from "./route-contracts";
import { writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

test("TypeBox 1 opacity follows the boundary kind across routes, response maps and jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-schema-opacity-"));
  const cases = [
    ["Nested", 'Type.Object({ id: Type.String(), metadata: Type.Unknown() })', false],
    ["Dictionary", 'Type.Record(Type.String(), Type.Unknown())', false],
    ["Array", 'Type.Array(Type.Unknown())', false],
    ["Unknown", 'Type.Unknown()', true],
    ["Any", 'Type.Any()', true],
    ["Alias", 'Unknown', true],
    ["RefinedUnknown", 'Type.Refine(Type.Unknown(), () => true)', true],
    ["PermissiveUnion", 'Type.Union([Nested, Unknown])', true],
    ["BoundedIntersection", 'Type.Intersect([Nested, Unknown])', false],
    ["OpaqueIntersection", 'Type.Intersect([Unknown, Any])', true],
  ] as const;
  try {
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/contracts.ts": `import { Type } from "typebox";\n${
        cases.map(([name, expression]) => `export const ${name} = ${expression};`).join("\n")
      }`,
      "src/fixture.module.ts": `
        import { Controller, Post, Job, Module } from "./runtime";
        import { ${cases.map(([name]) => name).join(", ")} } from "./contracts";
        @Controller("/fixture")
        class FixtureController {
          ${cases.map(([name]) => `
            @Post("/${name}", { body: ${name}, response: ${name} })
            ${name}() {}
            @Post("/${name}/map", { responses: { 200: ${name} } })
            ${name}Map() {}
          `).join("\n")}
          @Post("/mixed", { responses: { 200: Nested, 500: Unknown } })
          mixed() {}
        }
        ${cases.map(([name]) => `
          @Job({ name: "${name}", input: ${name}, output: ${name} })
          class ${name}Job { run(input: unknown) { return input; } }
        `).join("\n")}
        @Module({ name: "fixture", controllers: [FixtureController],
          jobs: [${cases.map(([name]) => `${name}Job`).join(", ")}] })
        export class FixtureModule {}
      `,
    });
    const graph = await analyzeProject(root);
    const module = graph.modules[0];
    expect(module).toBeDefined();
    const routes = module?.controllers[0]?.routes ?? [];
    for (const [name, , opaque] of cases) {
      const kind = opaque ? "opaque" : "declared";
      expect(routes.find((route) => route.handler === name)?.schemaKinds).toEqual({ body: kind, response: kind });
      expect(routes.find((route) => route.handler === `${name}Map`)?.schemaKinds).toEqual({ response: kind });
      expect(module?.jobs?.find((job) => job.name === name)?.schemaKinds).toEqual({ input: kind, output: kind });
    }
    expect(routes.find((route) => route.handler === "mixed")?.schemaKinds).toEqual({ response: "opaque" });
    const unverified = validateRouteContracts(graph).filter((diagnostic) => diagnostic.code === "route-contract-unverified");
    expect(unverified).toHaveLength(cases.filter(([, , opaque]) => opaque).length * 2 + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested unknown fields do not remove object and record runtime constraints", () => {
  const object = Type.Object({ id: Type.String(), metadata: Type.Unknown() });
  expect(Value.Check(object, { id: "one", metadata: { arbitrary: true } })).toBe(true);
  expect(Value.Check(object, { id: 1, metadata: null })).toBe(false);
  expect(Value.Check(object, null)).toBe(false);
  const record = Type.Record(Type.String(), Type.Unknown());
  expect(Value.Check(record, { arbitrary: true })).toBe(true);
  expect(Value.Check(record, null)).toBe(false);
  expect(Value.Check(record, [])).toBe(false);
});
