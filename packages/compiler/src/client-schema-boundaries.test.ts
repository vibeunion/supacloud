import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateClientSchemaBoundaries } from "./client-schema-boundaries";
import { checkProject, compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph } from "./types";

function fixture(): ApplicationGraph {
  return {
    externalTokens: [],
    modules: [{
      name: "items", className: "ItemsModule", file: "items.module.ts", line: 1,
      imports: [], providers: [], commands: [], queries: [], exports: [],
      controllers: [{
        className: "ItemsController", path: "/items", scope: "request", deps: [],
        file: "items.controller.ts", importPath: "items.controller",
        schemaImports: { Params: "./items.controller", Result: "./contracts" },
        routes: [
          { method: "GET", path: "/:id", handler: "detail", params: "Params", responses: { 200: "Result" } },
          { method: "POST", path: "/:id", handler: "save", params: "Params", response: "Result" },
        ],
      }],
    }],
  };
}

test("client generation diagnoses direct runtime imports once per schema", () => {
  expect(validateClientSchemaBoundaries(fixture(), { rootDir: "/project", generateClient: true })).toEqual([
    expect.objectContaining({ severity: "warn", code: "client-schema-runtime-import", file: "items.controller.ts" }),
  ]);
});

test("server-only compilation does not require browser-safe schema modules", () => {
  expect(validateClientSchemaBoundaries(fixture(), { rootDir: "/project", generateClient: false })).toEqual([]);
  expect(validateClientSchemaBoundaries(fixture(), { rootDir: "/project" })).toEqual([]);
});

test("separate contract modules are allowed and extension-qualified paths are normalized", () => {
  const graph = fixture();
  const controller = graph.modules[0]!.controllers[0]!;
  controller.schemaImports!.Params = "./items.controller.ts";
  expect(validateClientSchemaBoundaries(graph, { rootDir: "/project", generateClient: true })).toHaveLength(1);
  controller.schemaImports!.Params = "./items.route-contracts";
  expect(validateClientSchemaBoundaries(graph, { rootDir: "/project", generateClient: true })).toEqual([]);
});

test("unused controller exports do not trigger a schema warning", () => {
  const graph = fixture();
  graph.modules[0]!.controllers[0]!.routes = [{ method: "GET", path: "", handler: "list", response: "Result" }];
  expect(validateClientSchemaBoundaries(graph, { rootDir: "/project", generateClient: true })).toEqual([]);
});

test("error response schemas are checked, not only success schemas", () => {
  const graph = fixture();
  graph.modules[0]!.controllers[0]!.routes = [{
    method: "GET", path: "", handler: "list", responses: { 200: "Result", "4XX": "Params" },
  }];
  expect(validateClientSchemaBoundaries(graph, { rootDir: "/project", generateClient: true })).toHaveLength(1);
});

test("compile and check report the same diagnostic and strict compilation preserves artifacts", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-client-boundary-"));
  try {
    await writeFixtureProject(rootDir, {
      "app.ts": [
        'import { Controller, Get, Module } from "@supacloud/app";',
        'import { Type } from "typebox";',
        'export const Result = Type.Object({ id: Type.String() });',
        '@Controller("/items")',
        'export class ItemsController { @Get("", { response: Result }) list() { return { id: "1" }; } }',
        '@Module({ name: "items", controllers: [ItemsController] })',
        'export class ItemsModule {}',
      ].join("\n"),
    });
    const options = { rootDir, outDir: join(rootDir, "generated"), generateClient: true, strict: true, writeOnError: false };
    const compiled = await compileProject(options);
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error", code: "client-schema-runtime-import",
    }));
    expect(compiled.written).toEqual([]);
    const checked = await checkProject(options);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error", code: "client-schema-runtime-import",
    }));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
