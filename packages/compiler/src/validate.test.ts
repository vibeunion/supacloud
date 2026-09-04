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

    // Rule: type:ui cannot depend on type:data-access (can only depend on type:ui or type:contracts)
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

  test("moduleBoundaryPreset blocks cross-feature dependencies and core-to-feature dependencies", () => {
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
          imports: ["feature-billing"], // Violation: feature slices cannot depend on one another.
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
          imports: ["feature-billing"], // Violation: core modules cannot depend upward on features.
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
    expect(violations[0].message).toContain("feature-billing");
    expect(violations[1].message).toContain("core-auth");
    expect(violations[1].message).toContain("feature-billing");
  });

  test("moduleBoundaryPreset protects domain purity and layering direction", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "domain-case",
          className: "DomainCaseModule",
          tags: ["type:domain"],
          file: "src/domain.module.ts",
          line: 1,
          imports: ["api-controller"], // Violation: the domain cannot depend on API/controller layers.
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
    expect(violations[0].message).toContain("api-controller");
  });

  test("moduleBoundaryPreset merges with custom rules", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "feature-case",
          className: "FeatureCaseModule",
          tags: ["type:feature", "scope:case"],
          file: "src/case.module.ts",
          line: 1,
          imports: ["feature-billing"], // Violation 1: the modular-monolith preset blocks cross-feature dependencies.
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
          bannedDependenciesWithTags: ["scope:billing"], // Violation 2: custom scope isolation rule.
        },
      ],
    });

    const violations = diags.filter((d) => d.code === "module-boundary-violation");
    expect(violations).toHaveLength(2);
  });

  test("moduleBoundaryPreset reports invalid-boundary-preset for unknown presets", () => {
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
    expect(errors[0].message).toContain("Unknown module boundary preset");
  });

  test("commandCapabilities validates runtime governance support", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "case",
          className: "CaseModule",
          file: "src/case.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [
            {
              className: "CreateCaseCommand",
              name: "case.create",
              permission: "case:write",
              audit: "case.created",
              idempotency: "required",
              transaction: "required",
            },
          ],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    // 1. Report unsupported capabilities.
    const diags1 = validateGraph(sampleGraph, {
      commandCapabilities: {
        permission: false,
        audit: false,
        idempotency: false,
        transaction: "rpc-only",
      },
    });

    expect(diags1.some((d) => d.code === "command-permission-unsupported" && d.severity === "error")).toBe(true);
    expect(diags1.some((d) => d.code === "command-audit-unsupported" && d.severity === "error")).toBe(true);
    expect(diags1.some((d) => d.code === "command-idempotency-unsupported" && d.severity === "error")).toBe(true);
    expect(diags1.some((d) => d.code === "command-transaction-rpc-only" && d.severity === "warn")).toBe(true);

    // 2. Report disabled transaction support.
    const diags2 = validateGraph(sampleGraph, {
      commandCapabilities: {
        transaction: false,
      },
    });
    expect(diags2.some((d) => d.code === "command-transaction-unsupported" && d.severity === "error")).toBe(true);
  });

  test("allowRouteCommandBindings rejects route-level command bindings when disabled", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "case",
          className: "CaseModule",
          file: "src/case.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "CaseController",
              path: "/cases",
              scope: "request",
              deps: [],
              file: "src/case.controller.ts",
              importPath: "./case.controller",
              routes: [
                {
                  method: "POST",
                  path: "",
                  handler: "create",
                  command: "CreateCaseCommand",
                },
              ],
            },
          ],
          commands: [
            {
              className: "CreateCaseCommand",
              name: "case.create",
              permission: "case:write",
              idempotency: "none",
              transaction: "none",
            },
          ],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    // Route-level bindings are allowed by default.
    const defaultDiags = validateGraph(sampleGraph);
    expect(defaultDiags.filter((d) => d.code === "route-command-binding-disallowed")).toHaveLength(0);

    // Explicitly disable route-level bindings.
    const disallowedDiags = validateGraph(sampleGraph, {
      allowRouteCommandBindings: false,
    });
    const errors = disallowedDiags.filter((d) => d.code === "route-command-binding-disallowed");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("route-level command bindings are disabled");
  });

  test("circular-module-import detects module-level cycles", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "moduleA",
          className: "ModuleA",
          file: "src/a.module.ts",
          line: 1,
          imports: ["moduleB"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "moduleB",
          className: "ModuleB",
          file: "src/b.module.ts",
          line: 1,
          imports: ["moduleA"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const cycles = diags.filter((d) => d.code === "circular-module-import");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].severity).toBe("error");
    expect(cycles[0].message).toContain("moduleA -> moduleB -> moduleA");
  });

  test("orphan-module detects unreachable modules when a root exists", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          tags: ["type:root"],
          file: "src/app.module.ts",
          line: 1,
          imports: ["connected"],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "connected",
          className: "ConnectedModule",
          tags: ["type:feature"],
          file: "src/connected.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "orphan",
          className: "OrphanModule",
          tags: ["type:feature"],
          file: "src/orphan.module.ts",
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

    const diags = validateGraph(sampleGraph, { detectOrphanModules: true });
    const orphans = diags.filter((d) => d.code === "orphan-module");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe("warn");
    expect(orphans[0].message).toContain("Module 'orphan' is declared but not reachable");
  });

  test("disallowControllerDirectDb rejects direct database client injection", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "case",
          className: "CaseModule",
          file: "src/case.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "CaseController",
              path: "/cases",
              scope: "request",
              deps: ["DB_CLIENT"],
              file: "src/case.controller.ts",
              importPath: "./case.controller",
              routes: [],
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: ["DB_CLIENT"],
    };

    const defaultDiags = validateGraph(sampleGraph);
    expect(defaultDiags.filter((d) => d.code === "controller-direct-db-access")).toHaveLength(0);

    const strictDiags = validateGraph(sampleGraph, { disallowControllerDirectDb: true });
    const errors = strictDiags.filter((d) => d.code === "controller-direct-db-access");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("violating presentation layer separation");
  });
});
