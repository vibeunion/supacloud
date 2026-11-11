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
  formatDoctorCheck,
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
      "CaseModule", "CaseService", "CASE_SERVICE", "CaseRepository",
      "CaseController", "AcceptCaseCommand", "case.accept",
    ]) {
      expect(createContextPack(graph, target)).toEqual(expected);
    }
  });

  test("context files include the selected module feature specification source", () => {
    const featureGraph = structuredClone(graph);
    featureGraph.modules[0]!.featureSpec = {
      name: "case", states: ["draft", "accepted"], transitions: [],
      file: "case-feature.ts", line: 1,
    };
    expect(createContextPack(featureGraph, featureGraph.modules[0]!.name).files).toContain("case-feature.ts");
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
      "commandExecutor", "authorize", "idempotency", "transaction",
      "module:case.aspect[0]:auditAspect", "route.aspect[0]:auditAspect",
      "command.aspect[0]:auditAspect", "handler", "audit",
    ]);
    expect(createContextPack(fixture, "case").files).toContain("src/audit.ts");
    expect(explainGraph(fixture, "case")).toContain(plan.stages.join(" -> "));
  });

  test("conditional commands expose concrete RPC and fallback stage paths", () => {
    const module = graph.modules.find((item) => item.name === "case")!;
    const changed = {
      ...module,
      commands: [{
        className: "SaveCase",
        name: "case.save",
        permission: "case.save",
        transaction: "required" as const,
        idempotency: "required" as const,
        audit: "case.saved",
        branchesFallback: "command" as const,
        branches: [{
          when: 'kind === "external"', rpc: "save_external", transaction: "none" as const,
          idempotency: "required" as const, audit: "case.external.saved", boundary: "external" as const,
        }],
      }],
    };
    const plan = createExecutionPlans({ ...graph, modules: [changed] })
      .find((item) => item.kind === "command" && item.name === "case.save");
    expect(plan).toEqual(expect.objectContaining({
      stages: expect.arrayContaining([
        "rpc:selected-branch", "rpc:save_external", "idempotency", "transaction", "handler", "audit",
      ]),
      stagePaths: [
        ["commandExecutor", "authorize", "rpc:save_external", "handler"],
        ["commandExecutor", "authorize", "idempotency", "transaction", "handler", "audit"],
      ],
    }));
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
    expect(explainGraph(graph, "DB_CLIENT")).toContain("provided by: trusted delivery host/runtime");
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
    expect(pack.conventions).toEqual({
      singleResult: "async-await",
      eventComposition: "rxjs",
      angularHost: "@supacloud/app/angular",
      cancellation: "explicit-owner-signal",
      readTransport: "postgrest-supabase-js",
      writeTransport: {
        ordinaryCrud: "postgrest-supabase-js",
        compilerLane: "model-command",
        governedSql: "governed-sql",
        legacyRpc: "legacy-rpc",
      },
      writeRetry: "disabled",
      externalOutcome: "receipt-reconcile",
      databaseSource: "zmodel-append-only",
    });
    expect(pack.conventions.writeTransport).not.toBe("command-rpc");
    expect(Object.values(pack.conventions.writeTransport)).toEqual([
      "postgrest-supabase-js",
      "model-command",
      "governed-sql",
      "legacy-rpc",
    ]);
  });

  test("context packs omit provider values and source expressions", () => {
    const sourceModule = graph.modules.find((module) => module.name === "case")!;
    const module = {
      ...sourceModule,
      providers: [{
        ...sourceModule.providers[0]!,
        useValueExpr: "process.env.SUPABASE_SERVICE_ROLE_KEY",
        useFactoryName: "createSecretBackedAdapter",
      }],
      aspects: [{ name: "secretAspect", expression: "readSecret(process.env.KEY)", file: "src/secret.ts" }],
    };
    const pack = createContextPack({ ...graph, modules: graph.modules.map((item) => item.name === "case" ? module : item) }, "case");
    expect(pack.modules.find((item) => item.name === "case")?.providers[0]).toMatchObject({
      useValueExpr: "[omitted]",
      useFactoryName: "[omitted]",
    });
    expect(pack.modules.find((item) => item.name === "case")?.aspects?.[0]?.expression).toBe("[omitted]");
    expect(JSON.stringify(pack)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  test("doctorProject 汇总生成物、模块和诊断状态", async () => {
    await compileProject({ rootDir, outDir });
    const result = await checkProject({ rootDir, outDir });
    const doctor = doctorProject(rootDir, outDir, result.graph, result.upToDate, result.diagnostics);
    expect(doctor.errors).toBe(0);
    expect(doctor.checks.every((check) => check.ok)).toBe(true);
    expect(doctor.checks.map((check) => [check.name, check.layer])).toEqual([
      ["project-root", "source"],
      ["tsconfig", "source"],
      ["modules", "source"],
      ["generated-artifacts", "artifact"],
    ]);
    const artifacts = doctor.checks.find((check) => check.name === "generated-artifacts");
    expect(formatDoctorCheck(artifacts!)).toBe("OK artifact generated-artifacts: application.ts and app.manifest.json are up to date");
  });

  test("doctorProject 失败检查标出源码或产物层", () => {
    const missingRoot = join(rootDir, "missing-project");
    const missing = doctorProject(missingRoot, join(missingRoot, "generated"), { modules: [], externalTokens: [] }, false, [
      { severity: "error", code: "missing-module", message: "module source is invalid" },
    ]);
    const failed = (name: string) => missing.checks.find((check) => check.name === name);
    expect(failed("project-root")).toMatchObject({ ok: false, layer: "source", detail: `missing: ${missingRoot}` });
    expect(failed("tsconfig")).toMatchObject({ ok: false, layer: "source", detail: "tsconfig.json missing" });
    expect(failed("modules")).toMatchObject({ ok: false, layer: "source", detail: "0 module(s) discovered" });
    expect(failed("generated-artifacts")).toMatchObject({
      ok: false,
      layer: "artifact",
      detail: "generated artifacts are missing or stale",
    });
    expect(formatDoctorCheck(failed("project-root")!)).toBe(`FAIL source project-root: missing: ${missingRoot}`);
    expect(formatDoctorCheck(failed("generated-artifacts")!)).toBe(
      "FAIL artifact generated-artifacts: generated artifacts are missing or stale",
    );
    expect(missing.errors).toBe(5);

    const stale = doctorProject(rootDir, join(rootDir, "not-generated"), graph, false);
    expect(stale.checks.find((check) => check.name === "project-root")).toMatchObject({ ok: true, layer: "source" });
    expect(stale.checks.find((check) => check.name === "tsconfig")).toMatchObject({ ok: true, layer: "source" });
    expect(stale.checks.find((check) => check.name === "modules")).toMatchObject({ ok: true, layer: "source" });
    expect(stale.checks.find((check) => check.name === "generated-artifacts")).toMatchObject({ ok: false, layer: "artifact" });
    expect(formatDoctorCheck(stale.checks.find((check) => check.name === "generated-artifacts")!)).toBe(
      "FAIL artifact generated-artifacts: generated artifacts are missing or stale",
    );
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
