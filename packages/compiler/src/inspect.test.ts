import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { checkProject, compileProject } from "./compile";
import { doctorProject, explainGraph, formatGraph } from "./inspect";
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

  test("doctorProject 汇总生成物、模块和诊断状态", async () => {
    await compileProject({ rootDir, outDir });
    const result = await checkProject({ rootDir, outDir });
    const doctor = doctorProject(rootDir, outDir, result.graph, result.upToDate, result.diagnostics);
    expect(doctor.errors).toBe(0);
    expect(doctor.checks.every((check) => check.ok)).toBe(true);
  });
});
