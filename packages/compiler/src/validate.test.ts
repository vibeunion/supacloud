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

  test("command-missing-permission：始终为 error", () => {
    const missing = byCode("command-missing-permission");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("error");
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

  test("module-boundary-violation：根据 Nx 风格 Tag 规则拦截越权依赖", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "ui",
          className: "UiModule",
          tags: ["type:ui", "scope:case"],
          file: "src/ui.module.ts",
          line: 1,
          imports: ["data-access"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "data-access",
          className: "DataAccessModule",
          tags: ["type:data-access", "scope:case"],
          file: "src/data-access.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    // Rule: type:ui 不能依赖 type:data-access (只能依赖 type:ui 或 type:contracts)
    const diags = validateGraph(sampleGraph, {
      moduleBoundaries: [
        {
          sourceTag: "type:ui",
          bannedDependenciesWithTags: ["type:data-access"],
        },
      ],
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("error");
    expect(violations[0].message).toContain("禁止依赖带有标签 'type:data-access'");
  });

  test("module-boundary-violation：onlyDependOnLibsWithTags 白名单约束", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "contracts",
          className: "ContractsModule",
          tags: ["type:contracts"],
          file: "src/contracts.module.ts",
          line: 1,
          imports: ["feature-case"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "feature-case",
          className: "FeatureCaseModule",
          tags: ["type:feature"],
          file: "src/feature.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph, {
      moduleBoundaries: [
        {
          sourceTag: "type:contracts",
          onlyDependOnLibsWithTags: ["type:contracts", "type:util"],
        },
      ],
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("仅允许依赖带有 [type:contracts, type:util]");
  });

  test("moduleBoundaryPreset：modular-monolith 预设拦截 Feature 之间交叉依赖与 Core 反向依赖", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          tags: ["type:root"],
          file: "src/app.module.ts",
          line: 1,
          imports: ["feature-case", "core-auth"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "feature-case",
          className: "FeatureCaseModule",
          tags: ["type:feature"],
          file: "src/case.module.ts",
          line: 1,
          imports: ["feature-billing"], // 违规：Feature 之间禁止交叉依赖
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "feature-billing",
          className: "FeatureBillingModule",
          tags: ["type:feature"],
          file: "src/billing.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "core-auth",
          className: "CoreAuthModule",
          tags: ["type:core"],
          file: "src/core.module.ts",
          line: 1,
          imports: ["feature-billing"], // 违规：Core 禁止反向依赖 Feature
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph, {
      moduleBoundaryPreset: "modular-monolith",
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(2);
    expect(violations[0].message).toContain("feature-case");
    expect(violations[0].message).toContain("禁止依赖带有标签 'type:feature'");
    expect(violations[1].message).toContain("core-auth");
    expect(violations[1].message).toContain("禁止依赖带有标签 'type:feature'");
  });

  test("moduleBoundaryPreset：clean-architecture 预设保护领域层纯净与分层依赖流向", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "domain-case",
          className: "DomainCaseModule",
          tags: ["type:domain"],
          file: "src/domain.module.ts",
          line: 1,
          imports: ["api-controller"], // 违规：Domain 绝不能依赖上层 API/Controller
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "api-controller",
          className: "ApiControllerModule",
          tags: ["type:api"],
          file: "src/api.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph, {
      moduleBoundaryPreset: "clean-architecture",
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("domain-case");
    expect(violations[0].message).toContain("禁止依赖带有标签 'type:api'");
  });

  test("moduleBoundaryPreset：预设与自定义规则合并生效", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "feature-case",
          className: "FeatureCaseModule",
          tags: ["type:feature", "scope:case"],
          file: "src/case.module.ts",
          line: 1,
          imports: ["feature-billing"], // 违规 1：modular-monolith 预设拦截 feature 间依赖
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "feature-billing",
          className: "FeatureBillingModule",
          tags: ["type:feature", "scope:billing"],
          file: "src/billing.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph, {
      moduleBoundaryPreset: "modular-monolith",
      moduleBoundaries: [
        {
          sourceTag: "scope:case",
          bannedDependenciesWithTags: ["scope:billing"], // 违规 2：自定义 scope 隔离规则
        },
      ],
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(2);
  });

  test("moduleBoundaryPreset：传入未知预设时产生明确的 invalid-boundary-preset 错误诊断", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph, {
      moduleBoundaryPreset: "non-existent-preset" as any,
    });

    const errors = diags.filter((d) => d.code === "invalid-boundary-preset");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("未知的模块边界预设 Profile");
  });
});
