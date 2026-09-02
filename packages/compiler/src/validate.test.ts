import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { BAD_PROJECT_FILES } from "./fixtures/bad-project";
import { lineOf, writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph, Diagnostic } from "./types";
import { validateGraph } from "./validate";

let graph: ApplicationGraph;
let diagnostics: Diagnostic[];

function allDiagnostics(strict = false): Diagnostic[] {
  return [...(graph.diagnostics ?? []), ...validateGraph(graph, strict)];
}

function byCode(code: string): Diagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-bad-"));
  await writeFixtureProject(rootDir, BAD_PROJECT_FILES);
  graph = await analyzeProject(rootDir);
  diagnostics = allDiagnostics();
});

describe("validateGraph：坏 fixture 诊断", () => {
  test("circular-dependency：报环路径与位置", () => {
    const cycles = byCode("circular-dependency");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].severity).toBe("error");
    expect(cycles[0].message).toContain("CYCLE_A -> CYCLE_B -> CYCLE_A");
    expect(cycles[0].file).toBe("src/cycle.ts");
    expect(cycles[0].line).toBe(lineOf(BAD_PROJECT_FILES["src/cycle.ts"], "marker:circular"));
  });

  test("scope-violation：application provider 依赖 request provider", () => {
    const violations = byCode("scope-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("error");
    expect(violations[0].message).toContain("AppConfigService");
    expect(violations[0].message).toContain("SESSION");
    expect(violations[0].file).toBe("src/scope.ts");
    expect(violations[0].line).toBe(
      lineOf(BAD_PROJECT_FILES["src/scope.ts"], "marker:scope-violation"),
    );
  });

  test("module-boundary：token 由未 import 的模块提供", () => {
    const boundaries = byCode("module-boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].severity).toBe("error");
    expect(boundaries[0].message).toContain("HIDDEN_TOKEN");
    expect(boundaries[0].message).toContain("hidden");
    expect(boundaries[0].file).toBe("src/boundary.ts");
    expect(boundaries[0].line).toBe(
      lineOf(BAD_PROJECT_FILES["src/boundary.ts"], "marker:module-boundary"),
    );
  });

  test("duplicate-token：同模块重复注册", () => {
    const duplicates = byCode("duplicate-token");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].severity).toBe("error");
    expect(duplicates[0].message).toContain("DupService");
    expect(duplicates[0].file).toBe("src/misc.ts");
    expect(duplicates[0].line).toBe(
      lineOf(BAD_PROJECT_FILES["src/misc.ts"], "marker:duplicate-token"),
    );
  });

  test("command-missing-permission：warn，strict 时升级 error", () => {
    const missing = byCode("command-missing-permission");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("warn");
    expect(missing[0].message).toContain("bad.noperm");

    const strictDiagnostics = allDiagnostics(true).filter(
      (d) => d.code === "command-missing-permission",
    );
    expect(strictDiagnostics[0].severity).toBe("error");
  });

  test("missing-deps：构造参数类型无法解析为已知 token/类", () => {
    const missing = byCode("missing-deps");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("warn");
    expect(missing[0].message).toContain("MysteryService");
    expect(missing[0].file).toBe("src/misc.ts");
    expect(missing[0].line).toBe(
      lineOf(BAD_PROJECT_FILES["src/misc.ts"], "marker:missing-deps"),
    );
  });

  test("HIDDEN_TOKEN 有 provider，不算 externalToken", () => {
    expect(graph.externalTokens).not.toContain("HIDDEN_TOKEN");
  });

  test("duplicate-command：拒绝重复的业务命令名", () => {
    const duplicates = byCode("duplicate-command");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].message).toContain("bad.duplicate");
  });

  test("duplicate-route：拒绝规范化后重复的方法和路径", () => {
    const duplicates = byCode("duplicate-route");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].message).toContain("POST /duplicate");
  });

  test("route-command-unresolved：路由只能绑定本模块声明的命令", () => {
    const unresolved = byCode("route-command-unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toContain("MissingCommand");
    expect(unresolved[0].message).toContain("route-two");
  });
});
