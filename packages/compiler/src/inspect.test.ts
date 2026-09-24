import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { checkProject, compileProject } from "./compile";
import {
  createContextPack,
  createExecutionPlans,
  doctorProject,
  explainGraph,
  exportGraphDot,
  exportGraphMermaid,
  formatGraph,
} from "./inspect";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph } from "./types";
import { createDependencyGraphCache } from "./incremental";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { renderApplication } from "./generate";

let rootDir: string;
let outDir: string;
let graph: ApplicationGraph;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-inspect-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  outDir = join(rootDir, "generated");
  graph = await analyzeProject(rootDir);
});

describe("compiler inspection", () => {
  test("independently registered handlers retain source files and diagnostics across cached analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-handler-context-"));
    try {
      await writeFixtureProject(root, {
        "tsconfig.json": FIXTURE_TSCONFIG,
        "runtime.ts": RUNTIME_SOURCE,
        "feature.module.ts": `import { Module } from "./runtime";
import { Approve } from "./approve";
import { List } from "./list";
@Module({ name: "feature", commands: [Approve], queries: [List] })
export class FeatureModule {}`,
        "approve.ts": `import { Command } from "./runtime";
@Command({ name: "feature.approve", transaction: "requried" })
export class Approve {}`,
        "list.ts": `import { Query } from "./runtime";
@Query({ name: "feature.list" })
export class List {}`,
      });
      const cache = createDependencyGraphCache();
      const initial = await analyzeProject(root, undefined, cache);
      const cached = await analyzeProject(root, undefined, cache, []);
      expect(cached.cacheStats?.reusedModules).toEqual(["feature"]);
      for (const analyzed of [initial, cached]) {
        expect(analyzed.modules[0]?.providers).toEqual([]);
        for (const target of ["Approve", "feature.list"]) {
          const pack = createContextPack(analyzed, target);
          expect(pack.files).toEqual(["approve.ts", "feature.module.ts", "list.ts"]);
          expect(pack.diagnostics).toContainEqual(expect.objectContaining({
            code: "invalid-command-mode", file: "approve.ts",
          }));
          expect(pack).toEqual(createContextPack(analyzed, "feature"));
        }
        const options = { rootDir: root, outDir: join(root, "generated") };
        const { moduleHandlerFiles: _handlerFiles, ...withoutInspectionMetadata } = analyzed;
        expect(renderApplication(analyzed, options)).toEqual(renderApplication(withoutInspectionMetadata, options));
      }
      const previousEntry = cache.modules.get("feature")!;
      delete previousEntry.handlerFiles;
      const restored = await analyzeProject(root, undefined, cache, []);
      expect(restored.cacheStats?.reanalyzedModules).toEqual(["feature"]);
      expect(createContextPack(restored, "Approve").files).toContain("approve.ts");

      await rename(join(root, "approve.ts"), join(root, "approved.ts"));
      await rm(join(root, "list.ts"));
      await writeFile(join(root, "feature.module.ts"), `import { Module } from "./runtime";
import { Approve } from "./approved";
@Module({ name: "feature", commands: [Approve] })
export class FeatureModule {}`);
      const moved = await analyzeProject(root, undefined, cache, ["approve.ts", "approved.ts", "list.ts", "feature.module.ts"]);
      const movedPack = createContextPack(moved, "Approve");
      expect(movedPack.files).toEqual(["approved.ts", "feature.module.ts"]);
      expect(movedPack.diagnostics).toContainEqual(expect.objectContaining({
        code: "invalid-command-mode", file: "approved.ts",
      }));
      expect(() => createContextPack(moved, "feature.list")).toThrow("No context target");

      await writeFile(join(root, "feature.module.ts"), `import { Module } from "./runtime";
@Module({ name: "feature" })
export class FeatureModule {}`);
      const empty = await analyzeProject(root, undefined, cache, ["feature.module.ts"]);
      expect(createContextPack(empty, "feature").files).toEqual(["feature.module.ts"]);
      const emptyCached = await analyzeProject(root, undefined, cache, []);
      expect(emptyCached.cacheStats?.reusedModules).toEqual(["feature"]);
      expect(emptyCached.moduleHandlerFiles?.feature).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context resolves owned symbols to the same existing module pack", () => {
    const expected = createContextPack(graph, "case");
    for (const target of [
      "CaseModule", "CaseService", "CASE_SERVICE", "DrizzleCaseRepository",
      "CaseController", "AcceptCaseCommand", "case.accept",
    ]) {
      expect(createContextPack(graph, target)).toEqual(expected);
    }
  });

  test("context resolves job and query names, classes and job service keys", () => {
    const modules = graph.modules.map((module) => module.name === "case" ? {
      ...module,
      jobs: [{ name: "case.rebuild", className: "RebuildJob", serviceKey: "REBUILD", scope: "job" as const }],
      queries: [{ name: "case.list", className: "ListCases" }],
    } : module);
    const fixture = { ...graph, modules };
    for (const target of ["case.rebuild", "RebuildJob", "REBUILD", "case.list", "ListCases"]) {
      expect(createContextPack(fixture, target)).toEqual(createContextPack(fixture, "case"));
    }
  });

  test("context rejects ambiguous owners without changing exact module selection", () => {
    const module = graph.modules.find((entry) => entry.name === "case")!;
    const fixture = { ...graph, modules: [...graph.modules, { ...module, name: "other" }] };
    expect(() => createContextPack(fixture, "CaseService")).toThrow('Select a module name: case, other');
    expect(createContextPack(fixture, "case").subject).toBe("case");
    expect(() => createContextPack(fixture, "missing")).toThrow('No context target named "missing"');
  });

  test("context follows each direction without expanding unrelated shared-module siblings", () => {
    const audit = graph.modules.find((module) => module.name === "audit")!;
    const unrelated = { ...audit, name: "unrelated", imports: ["audit"], file: "src/unrelated.ts" };
    const dependent = { ...audit, name: "consumer", imports: ["case"], file: "src/consumer.ts" };
    const pack = createContextPack({ ...graph, modules: [...graph.modules, unrelated, dependent] }, "case");
    expect(pack.modules.map((module) => module.name)).toEqual(["audit", "case", "consumer"]);
    expect(pack.files).not.toContain("src/unrelated.ts");
  });

  test("execution plans and context expose aspect sources and governance in declared order", () => {
    const module = graph.modules.find((module) => module.name === "case")!;
    const aspect = { name: "auditAspect", expression: "auditAspect", file: "src/audit.ts", importPath: "src/audit" };
    const changed = {
      ...module,
      aspects: [aspect],
      controllers: [{
        ...module.controllers[0],
        routes: [{ method: "POST" as const, path: "/approve", handler: "approve", command: "Approve", aspects: [aspect] }],
      }],
      commands: [{ className: "Approve", name: "case.approve", permission: "case.approve", transaction: "required" as const, idempotency: "required" as const, audit: "approved", aspects: [aspect] }],
    };
    const fixture = { ...graph, modules: [changed] };
    const plan = createExecutionPlans(fixture)[0];
    expect(plan.stages).toEqual([
      "module:case.aspect[0]:auditAspect", "route.aspect[0]:auditAspect",
      "command.aspect[0]:auditAspect", "commandExecutor", "authorize",
      "idempotency", "transaction", "handler", "audit",
    ]);
    expect(createContextPack(fixture, "case").files).toContain("src/audit.ts");
    expect(explainGraph(fixture, "case")).toContain(plan.stages.join(" -> "));
  });
  test("formatGraph 输出模块、依赖和平台 token", () => {
    const output = formatGraph(graph);
    expect(output).toContain("MODULE case");
    expect(output).toContain("imports: audit");
    expect(output).toContain("EXTERNAL TOKENS DB_CLIENT, REQUEST_CONTEXT");
  });

  test("explainGraph 支持模块、provider 和 external token", () => {
    expect(explainGraph(graph, "case")).toContain("imported by: -");
    expect(explainGraph(graph, "CaseService")).toContain("PROVIDER CaseService");
    expect(explainGraph(graph, "DB_CLIENT")).toContain("provided by: platform runtime");
  });

  test("explainGraph 对未知对象给出可操作的 known names", () => {
    expect(() => explainGraph(graph, "missing")).toThrow(/Known names:/);
  });

  test("createContextPack 提取目标模块及其上下游上下文", () => {
    const pack = createContextPack(graph, "case");
    expect(pack.version).toBe(1);
    expect(pack.subject).toBe("case");
    expect(pack.modules.map((module) => module.name)).toEqual(["audit", "case"]);
    expect(pack.files).toContain("src/features/case/case.module.ts");
    expect(pack.externalTokens).toContain("DB_CLIENT");
    expect(pack.relatedModules.imports).toEqual(["audit"]);
  });

  test("doctorProject 汇总生成物、模块和诊断状态", async () => {
    await compileProject({ rootDir, outDir });
    const result = await checkProject({ rootDir, outDir });
    const doctor = doctorProject(rootDir, outDir, result.graph, result.upToDate, result.diagnostics);
    expect(doctor.errors).toBe(0);
    expect(doctor.checks.every((check) => check.ok)).toBe(true);
  });

  test("exportGraphMermaid 和 exportGraphDot 生成模块依赖图可视化脚本", () => {
    const mermaid = exportGraphMermaid(graph);
    expect(mermaid).toContain("graph TD");
    expect(mermaid).toContain("case --> audit");

    const dot = exportGraphDot(graph);
    expect(dot).toContain("digraph ApplicationGraph");
    expect(dot).toContain('"case" -> "audit"');
  });
});
