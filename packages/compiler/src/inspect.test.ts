import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
