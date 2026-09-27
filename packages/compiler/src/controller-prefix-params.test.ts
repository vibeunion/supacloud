import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { validateGraph } from "./validate";
import { writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function analyzeController(prefix: string, route: string, parameters: string) {
  const root = await mkdtemp(join(tmpdir(), "supacloud-controller-prefix-"));
  roots.push(root);
  await writeFixtureProject(root, {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "runtime.ts": RUNTIME_SOURCE,
    "module.ts": `
      import { Module, Controller, Get, Param } from "./runtime";
      @Controller(${JSON.stringify(prefix)})
      class ProjectController {
        @Get(${JSON.stringify(route)})
        read(${parameters}) {}
      }
      @Module({ name: "projects", controllers: [ProjectController] })
      export class ProjectModule {}
    `,
  });
  return analyzeProject(root);
}

test("validates explicit parameters declared on the controller prefix", async () => {
  const graph = await analyzeController("/v1/projects/:ref", "/capabilities", '@Param("ref") ref: string');
  const route = graph.modules[0]?.controllers[0]?.routes[0];
  expect(route?.pathParams).toEqual(["ref"]);
  expect(route?.paramBindings).toEqual(["ref"]);
  expect(validateGraph(graph).filter((diagnostic) => diagnostic.code.includes("path-param"))).toEqual([]);
});

test("infers and transforms prefix parameters alongside method parameters", async () => {
  const graph = await analyzeController("/projects/:projectId/", "/items/:itemId", "projectId: number, itemId: string");
  const route = graph.modules[0]?.controllers[0]?.routes[0];
  expect(route?.pathParams).toEqual(["projectId", "itemId"]);
  expect(route?.paramBindings).toEqual(["projectId", "itemId"]);
  expect(route?.paramTransforms).toEqual({ projectId: "number" });
});

test("still rejects bindings absent from both prefix and method path", async () => {
  const graph = await analyzeController("/projects/:ref", "/environment", '@Param("missing") ref: string');
  expect(validateGraph(graph).some((diagnostic) => diagnostic.code === "unmatched-path-param")).toBe(true);
});

test("preserves duplicate prefix and method parameters for validation", async () => {
  const graph = await analyzeController("/projects/:ref", "/items/:ref", '@Param("ref") ref: string');
  expect(graph.modules[0]?.controllers[0]?.routes[0]?.pathParams).toEqual(["ref", "ref"]);
  expect(validateGraph(graph).some((diagnostic) => diagnostic.code === "duplicate-path-param")).toBe(true);
});
