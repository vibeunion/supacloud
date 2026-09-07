import { expect, test } from "bun:test";
import { inspectRouteContracts, validateRouteContracts } from "./route-contracts";
import type { ApplicationGraph } from "./types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject, checkProject } from "./compile";
import { compileOptionsFromConfig } from "./config";
import { createIncrementalCompiler } from "./incremental";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "items", className: "ItemsModule", file: "items.ts", line: 1,
    imports: [], providers: [], commands: [], queries: [], exports: [],
    controllers: [{
      className: "ItemsController", path: "/items/:id", scope: "request",
      deps: [], file: "items.ts", importPath: "./items",
      routes: [{
        method: "POST", path: "", handler: "save",
        handlerParams: [{ name: "dto", kind: "body" }, { name: "filter", kind: "query" }],
      }],
    }],
  }],
};

test("lists missing declarations including inherited path and handler bindings", () => {
  expect(inspectRouteContracts(graph)[0]?.missing).toEqual(["body", "params", "query", "response"]);
  expect(validateRouteContracts(graph)[0]).toMatchObject({ severity: "error", code: "route-contract-required", file: "items.ts" });
});

test("declared contracts have no missing-schema diagnostic without claiming runtime coverage", () => {
  const declared = structuredClone(graph);
  Object.assign(declared.modules[0]!.controllers[0]!.routes[0]!, {
    body: "Input", params: "Params", query: "Query", response: "Result",
  });
  expect(validateRouteContracts(declared)).toEqual([]);
  expect(inspectRouteContracts(declared)[0]).not.toHaveProperty("runtimeValidated");
});

test("config policy reaches compile/check and invalidates a prior incremental result", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-route-contracts-"));
  try {
    await writeFixtureProject(rootDir, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]!
        .replace("    response: AcceptResult,\n", ""),
    });
    const options = compileOptionsFromConfig({
      root: ".", outDir: "generated", strict: false, requireRouteContracts: true,
    }, rootDir);
    const compiled = await compileProject({ ...options, writeOnError: false });
    expect(compiled.diagnostics.some((item) => item.code === "route-contract-required")).toBe(true);
    expect(compiled.written).toEqual([]);
    const checked = await checkProject(options);
    expect(checked.diagnostics.filter((item) => item.code === "route-contract-required"))
      .toEqual(compiled.diagnostics.filter((item) => item.code === "route-contract-required"));
    const incremental = createIncrementalCompiler();
    await incremental.compile({ ...options, requireRouteContracts: false });
    const strict = await incremental.compile(options, []);
    expect(strict.stats.cacheHit).toBe(false);
    expect(strict.diagnostics.some((item) => item.code === "route-contract-required")).toBe(true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
