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
      moduleBoundaryPreset: "non-existent-preset" as never,
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

  test("multi: true allows duplicate tokens without duplicate-token diagnostic", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "plugins",
          className: "PluginsModule",
          file: "src/plugins.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "INTERCEPTOR",
              tokenKind: "injection-token",
              kind: "class",
              useClass: "AuthInterceptor",
              scope: "application",
              deps: [],
              multi: true,
              exported: true,
              file: "src/auth.interceptor.ts",
              line: 1,
              importPath: "./auth.interceptor",
            },
            {
              token: "INTERCEPTOR",
              tokenKind: "injection-token",
              kind: "class",
              useClass: "LogInterceptor",
              scope: "application",
              deps: [],
              multi: true,
              exported: true,
              file: "src/log.interceptor.ts",
              line: 1,
              importPath: "./log.interceptor",
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["INTERCEPTOR"],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    expect(diags.filter((d) => d.code === "duplicate-token")).toHaveLength(0);
  });

  test("optionalDeps suppresses missing-token errors and attaches actionable suggestions", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "test",
          className: "TestModule",
          file: "src/test.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "ServiceWithOptional",
              tokenKind: "class",
              kind: "class",
              useClass: "ServiceWithOptional",
              scope: "application",
              deps: ["OPTIONAL_LOGGER"],
              optionalDeps: ["OPTIONAL_LOGGER"],
              exported: true,
              file: "src/service.ts",
              line: 1,
              importPath: "./service",
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["ServiceWithOptional"],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    expect(diags.filter((d) => d.code === "module-boundary" || d.code === "missing-token")).toHaveLength(0);
  });

  test("providedIn: 'root' resolves dependencies across modules without imports", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "root",
          className: "RootModule",
          file: "src/root.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "RootConfigService",
              tokenKind: "class",
              kind: "class",
              useClass: "RootConfigService",
              scope: "application",
              providedIn: "root",
              deps: [],
              exported: true,
              file: "src/config.ts",
              line: 1,
              importPath: "./config",
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["RootConfigService"],
        },
        {
          name: "feature",
          className: "FeatureModule",
          file: "src/feature.module.ts",
          line: 1,
          imports: [], // Did not explicitly import RootModule
          providers: [
            {
              token: "FeatureService",
              tokenKind: "class",
              kind: "class",
              useClass: "FeatureService",
              scope: "application",
              deps: ["RootConfigService"],
              exported: true,
              file: "src/feature.service.ts",
              line: 1,
              importPath: "./feature.service",
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["FeatureService"],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    expect(diags.filter((d) => d.code === "module-boundary")).toHaveLength(0);
  });

  test("selfDeps requires provider to be declared in current module", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "feature",
          className: "FeatureModule",
          file: "src/feature.module.ts",
          line: 1,
          imports: ["core"],
          providers: [
            {
              token: "FeatureService",
              tokenKind: "class",
              kind: "class",
              useClass: "FeatureService",
              scope: "application",
              deps: ["ConfigToken"],
              selfDeps: ["ConfigToken"],
              exported: true,
              file: "src/feature.service.ts",
              line: 1,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
        {
          name: "core",
          className: "CoreModule",
          file: "src/core.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "ConfigToken",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              deps: [],
              exported: true,
              file: "src/core.ts",
              line: 1,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["ConfigToken"],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const selfDiag = diags.find((d) => d.code === "self-resolution-failed");
    expect(selfDiag).toBeDefined();
    expect(selfDiag?.message).toContain("@Self()");
  });

  test("skipSelfDeps rejects provider declared in own module", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "feature",
          className: "FeatureModule",
          file: "src/feature.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "LocalToken",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              deps: [],
              exported: true,
              file: "src/local.ts",
              line: 1,
            },
            {
              token: "FeatureService",
              tokenKind: "class",
              kind: "class",
              useClass: "FeatureService",
              scope: "application",
              deps: ["LocalToken"],
              skipSelfDeps: ["LocalToken"],
              exported: true,
              file: "src/feature.service.ts",
              line: 1,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const skipDiag = diags.find((d) => d.code === "skip-self-resolution-failed");
    expect(skipDiag).toBeDefined();
    expect(skipDiag?.message).toContain("@SkipSelf()");
  });

  test("circular redirectTo reports circular-route-redirect diagnostic", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "feature",
          className: "FeatureModule",
          file: "src/feature.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "RedirectController",
              path: "/cases",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/cases",
                  handler: "index",
                  redirectTo: "/cases",
                },
              ],
              file: "src/redirect.controller.ts",
              importPath: "./redirect.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const redirectDiag = diags.find((d) => d.code === "circular-route-redirect");
    expect(redirectDiag).toBeDefined();
    expect(redirectDiag?.message).toContain("circular redirectTo");
  });

  test("Ivy-style route parameter checking: unmatched and missing path parameters report actionable diagnostics", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "users",
          className: "UserModule",
          file: "src/user.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "UserController",
              path: "/users",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/:userId/roles/:roleId",
                  handler: "getRole",
                  pathParams: ["userId", "roleId"],
                  paramBindings: ["user_id"], // Typo: user_id instead of userId
                },
              ],
              file: "src/user.controller.ts",
              importPath: "./user.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const unmatchedDiag = diags.find((d) => d.code === "unmatched-path-param");
    expect(unmatchedDiag).toBeDefined();
    expect(unmatchedDiag?.severity).toBe("error");
    expect(unmatchedDiag?.message).toContain("binds @Param('user_id')");
    expect(unmatchedDiag?.suggestion).toContain("Did you mean @Param('userId')?");

    const missingDiags = diags.filter((d) => d.code === "missing-path-param");
    expect(missingDiags.length).toBeGreaterThan(0);
    expect(missingDiags.some((d) => d.message.includes("roleId"))).toBe(true);
  });

  test("Ivy-style route parameter checking: invalid @Body() binding on GET reports error", () => {
    const sampleGraph: ApplicationGraph = {
      modules: [
        {
          name: "items",
          className: "ItemModule",
          file: "src/item.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "ItemController",
              path: "/items",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/",
                  handler: "listItems",
                  hasBodyBinding: true,
                },
              ],
              file: "src/item.controller.ts",
              importPath: "./item.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(sampleGraph);
    const bodyDiag = diags.find((d) => d.code === "invalid-body-binding");
    expect(bodyDiag).toBeDefined();
    expect(bodyDiag?.severity).toBe("error");
    expect(bodyDiag?.message).toContain("binds @Body() on HTTP GET route");
    expect(bodyDiag?.suggestion).toContain("Use POST, PUT, or PATCH");
  });

  test("Ivy-style route order checking: shadowed-route detects specific routes shadowed by earlier wildcard", () => {
    const badGraph: ApplicationGraph = {
      modules: [
        {
          name: "items",
          className: "ItemsModule",
          file: "src/items.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "ItemsController",
              path: "/items",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/:id",
                  handler: "getItem",
                },
                {
                  method: "GET",
                  path: "/overview",
                  handler: "getOverview",
                },
              ],
              file: "src/items.controller.ts",
              importPath: "./items.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(badGraph);
    const shadowDiag = diags.find((d) => d.code === "shadowed-route");
    expect(shadowDiag).toBeDefined();
    expect(shadowDiag?.message).toContain("Route GET /items/overview (ItemsController.getOverview) is shadowed");
    expect(shadowDiag?.message).toContain("earlier parameterized route GET /items/:id");
    expect(shadowDiag?.suggestion).toContain("Move specific route '/overview' before parameterized route '/:id'");

    // If ordered correctly (specific first, then parameterized), no shadowed-route diagnostic
    const goodGraph: ApplicationGraph = {
      ...badGraph,
      modules: [
        {
          ...badGraph.modules[0],
          controllers: [
            {
              ...badGraph.modules[0].controllers[0],
              routes: [
                {
                  method: "GET",
                  path: "/overview",
                  handler: "getOverview",
                },
                {
                  method: "GET",
                  path: "/:id",
                  handler: "getItem",
                },
              ],
            },
          ],
        },
      ],
    };

    const goodDiags = validateGraph(goodGraph);
    expect(goodDiags.find((d) => d.code === "shadowed-route")).toBeUndefined();
  });

  test("unresolved-route-redirect warns when redirectTo points to non-existent route target", () => {
    const graphWithBrokenRedirect: ApplicationGraph = {
      modules: [
        {
          name: "routing",
          className: "RoutingModule",
          file: "src/routing.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "RoutingController",
              path: "/portal",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/dashboard",
                  handler: "getDashboard",
                },
                {
                  method: "GET",
                  path: "/old-dash",
                  handler: "getOldDash",
                  redirectTo: "/portal/dashbaord", // Typo in redirect target!
                },
                {
                  method: "GET",
                  path: "/home",
                  handler: "getHome",
                  redirectTo: "/portal/dashboard", // Valid redirect target
                },
              ],
              file: "src/routing.controller.ts",
              importPath: "./routing.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithBrokenRedirect);
    const redirectDiag = diags.find((d) => d.code === "unresolved-route-redirect");
    expect(redirectDiag).toBeDefined();
    expect(redirectDiag?.message).toContain("redirects to '/portal/dashbaord', but no matching route was found");
    expect(redirectDiag?.suggestion).toContain("Did you mean '/portal/dashboard'?");
  });

  test("Angular Ivy-style standardized error codes and docsUrls on diagnostics", () => {
    const badGraph: ApplicationGraph = {
      modules: [
        {
          name: "TestModule",
          className: "TestModule",
          file: "src/test.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "A",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              deps: ["B"],
              exported: false,
              file: "src/a.ts",
              line: 10,
            },
            {
              token: "B",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              deps: ["A"],
              exported: false,
              file: "src/b.ts",
              line: 20,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(badGraph);
    const cycleDiag = diags.find((d) => d.code === "circular-dependency");
    expect(cycleDiag).toBeDefined();
    expect(cycleDiag?.errorCode).toBe("SC1001");
    expect(cycleDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC1001");
  });

  test("Angular Ivy-style unused root provider tree-shaking detection", () => {
    const graphWithUnusedRoot: ApplicationGraph = {
      modules: [
        {
          name: "RootModule",
          className: "RootModule",
          file: "src/root.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "UsedService",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              providedIn: "root",
              deps: [],
              exported: false,
              file: "src/used.service.ts",
              line: 5,
            },
            {
              token: "OrphanRootService",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              providedIn: "root",
              deps: [],
              exported: false,
              file: "src/orphan.service.ts",
              line: 12,
            },
          ],
          controllers: [
            {
              className: "MainController",
              path: "/main",
              scope: "request",
              deps: ["UsedService"],
              routes: [],
              file: "src/main.controller.ts",
              importPath: "./main.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithUnusedRoot);
    const unused = diags.find((d) => d.code === "unused-root-provider");
    expect(unused).toBeDefined();
    expect(unused?.errorCode).toBe("SC5001");
    expect(unused?.message).toContain('Root provider "OrphanRootService" is declared with providedIn: \'root\'');
    expect(unused?.suggestion).toContain("enable tree-shaking");
  });

  test("detects circular useExisting alias chains (SC1007)", () => {
    const graphWithAliasCycle: ApplicationGraph = {
      modules: [
        {
          name: "alias-cycle-module",
          className: "AliasCycleModule",
          file: "src/alias.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              kind: "existing",
              token: "AliasA",
              tokenKind: "class",
              scope: "application",
              deps: [],
              useExisting: "AliasB",
              exported: false,
              file: "src/alias.ts",
              line: 10,
            },
            {
              kind: "existing",
              token: "AliasB",
              tokenKind: "class",
              scope: "application",
              deps: [],
              useExisting: "AliasA",
              exported: false,
              file: "src/alias.ts",
              line: 20,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithAliasCycle);
    const aliasDiag = diags.find((d) => d.code === "circular-existing-alias");
    expect(aliasDiag).toBeDefined();
    expect(aliasDiag?.errorCode).toBe("SC1007");
    expect(aliasDiag?.message).toContain("AliasA -> AliasB -> AliasA");
  });

  test("warns when handler binds @Body() without route body schema (SC3008)", () => {
    const graphWithMissingBodySchema: ApplicationGraph = {
      modules: [
        {
          name: "test-module",
          className: "TestModule",
          file: "src/test.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "OrderController",
              path: "/orders",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "POST",
                  path: "/create",
                  handler: "createOrder",
                  hasBodyBinding: true,
                  // body: undefined (missing schema)
                },
              ],
              file: "src/order.controller.ts",
              importPath: "./order.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithMissingBodySchema);
    const schemaDiag = diags.find((d) => d.code === "missing-body-schema");
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag?.errorCode).toBe("SC3008");
    expect(schemaDiag?.message).toContain("OrderController.createOrder binds @Body()");
  });

  test("warns when route specifies body schema but handler lacks @Body() binding (SC3009)", () => {
    const graphWithUnusedSchema: ApplicationGraph = {
      modules: [
        {
          name: "test-module",
          className: "TestModule",
          file: "src/test.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "ItemController",
              path: "/items",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "POST",
                  path: "/add",
                  handler: "addItem",
                  body: "ItemPayloadSchema",
                  hasBodyBinding: false,
                },
              ],
              file: "src/item.controller.ts",
              importPath: "./item.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithUnusedSchema);
    const schemaDiag = diags.find((d) => d.code === "unused-route-schema");
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag?.errorCode).toBe("SC3009");
    expect(schemaDiag?.message).toContain("defines body schema 'ItemPayloadSchema'");
  });

  test("detects multi-hop circular route redirect chains (SC3003)", () => {
    const graphWithMultiHopRedirectCycle: ApplicationGraph = {
      modules: [
        {
          name: "redirect-module",
          className: "RedirectModule",
          file: "src/redirect.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "RedirectController",
              path: "",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/step-a",
                  handler: "stepA",
                  redirectTo: "/step-b",
                },
                {
                  method: "GET",
                  path: "/step-b",
                  handler: "stepB",
                  redirectTo: "/step-c",
                },
                {
                  method: "GET",
                  path: "/step-c",
                  handler: "stepC",
                  redirectTo: "/step-a",
                },
              ],
              file: "src/redirect.controller.ts",
              importPath: "./redirect.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithMultiHopRedirectCycle);
    const redirectCycleDiag = diags.find(
      (d) => d.code === "circular-route-redirect" && d.message.includes("forms a cycle"),
    );
    expect(redirectCycleDiag).toBeDefined();
    expect(redirectCycleDiag?.errorCode).toBe("SC3003");
    expect(redirectCycleDiag?.message).toContain("/step-a -> /step-b -> /step-c -> /step-a");
  });

  test("detects malformed route paths with consecutive slashes, empty params, or query characters (SC3010)", () => {
    const graphWithMalformedRoutes: ApplicationGraph = {
      modules: [
        {
          name: "MalformedModule",
          className: "MalformedModule",
          file: "src/malformed.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "MalformedController",
              path: "/api",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/users//profile",
                  handler: "getProfile",
                },
                {
                  method: "GET",
                  path: "/items/:",
                  handler: "getItems",
                },
                {
                  method: "GET",
                  path: "/search?q=test",
                  handler: "search",
                },
              ],
              file: "src/malformed.controller.ts",
              importPath: "./malformed.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithMalformedRoutes);
    const malformedDiags = diags.filter((d) => d.code === "malformed-route-path");
    expect(malformedDiags).toHaveLength(3);
    for (const diag of malformedDiags) {
      expect(diag.errorCode).toBe("SC3010");
      expect(diag.docsUrl).toBe("https://supacloud.dev/errors/SC3010");
      expect(diag.suggestion).toBeDefined();
    }
    expect(malformedDiags.some((d) => d.message.includes("consecutive slashes"))).toBe(true);
    expect(malformedDiags.some((d) => d.message.includes("missing a parameter identifier"))).toBe(true);
    expect(malformedDiags.some((d) => d.message.includes("invalid URL query"))).toBe(true);
  });

  test("detects unprovided exported tokens in modules (SC2006)", () => {
    const graphWithUnprovidedExport: ApplicationGraph = {
      modules: [
        {
          name: "FaultyExportModule",
          className: "FaultyExportModule",
          file: "src/faulty.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [],
          commands: [],
          queries: [],
          exports: ["GhostToken"],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithUnprovidedExport);
    const exportDiag = diags.find((d) => d.code === "export-unprovided-token");
    expect(exportDiag).toBeDefined();
    expect(exportDiag?.errorCode).toBe("SC2006");
    expect(exportDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC2006");
    expect(exportDiag?.message).toContain("GhostToken");
  });

  test("detects duplicate path parameters in route paths (SC3011)", () => {
    const graphWithDuplicateParam: ApplicationGraph = {
      modules: [
        {
          name: "DupParamModule",
          className: "DupParamModule",
          file: "src/dup_param.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "DupParamController",
              path: "/orgs",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/:slug/teams/:slug",
                  pathParams: ["slug", "slug"],
                  handler: "getTeam",
                },
              ],
              file: "src/dup_param.controller.ts",
              importPath: "./dup_param.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithDuplicateParam);
    const dupParamDiag = diags.find((d) => d.code === "duplicate-path-param");
    expect(dupParamDiag).toBeDefined();
    expect(dupParamDiag?.errorCode).toBe("SC3011");
    expect(dupParamDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC3011");
    expect(dupParamDiag?.message).toContain(":slug");
  });

  test("detects unresolved useExisting alias targets (SC2007)", () => {
    const graphWithUnresolvedAlias: ApplicationGraph = {
      modules: [
        {
          name: "AliasModule",
          className: "AliasModule",
          file: "src/alias.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "MyServiceAlias",
              tokenKind: "injection-token",
              kind: "existing",
              exported: false,
              scope: "application",
              deps: [],
              useExisting: "GhostTargetService",
              file: "src/alias.module.ts",
              line: 10,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithUnresolvedAlias);
    const aliasDiag = diags.find((d) => d.code === "unresolved-alias-target");
    expect(aliasDiag).toBeDefined();
    expect(aliasDiag?.errorCode).toBe("SC2007");
    expect(aliasDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC2007");
    expect(aliasDiag?.message).toContain("GhostTargetService");
  });

  test("detects wildcard '**' in non-trailing position (SC3012)", () => {
    const graphWithInnerWildcard: ApplicationGraph = {
      modules: [
        {
          name: "WildcardModule",
          className: "WildcardModule",
          file: "src/wildcard.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "WildcardController",
              path: "/files",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/**/download",
                  handler: "download",
                },
              ],
              file: "src/wildcard.controller.ts",
              importPath: "./wildcard.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithInnerWildcard);
    const wildcardDiag = diags.find((d) => d.code === "wildcard-not-trailing");
    expect(wildcardDiag).toBeDefined();
    expect(wildcardDiag?.errorCode).toBe("SC3012");
    expect(wildcardDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC3012");
    expect(wildcardDiag?.message).toContain("trailing segment");
  });

  test("detects self-referencing provider useExisting alias (SC2008)", () => {
    const graphWithSelfAlias: ApplicationGraph = {
      modules: [
        {
          name: "AuthModule",
          className: "AuthModule",
          file: "src/auth.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "AuthService",
              tokenKind: "class",
              kind: "existing",
              useExisting: "AuthService",
              scope: "application",
              deps: [],
              file: "src/auth.service.ts",
              line: 10,
              exported: false,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithSelfAlias);
    const selfAliasDiag = diags.find((d) => d.code === "self-referencing-alias");
    expect(selfAliasDiag).toBeDefined();
    expect(selfAliasDiag?.errorCode).toBe("SC2008");
    expect(selfAliasDiag?.docsUrl).toBe("https://supacloud.dev/errors/SC2008");
    expect(selfAliasDiag?.message).toContain("referencing itself");
    expect(selfAliasDiag?.suggestion).toContain("different provider token");
  });

  test("detects invalid route query parameter names (SC3013)", () => {
    const graphWithInvalidQuery: ApplicationGraph = {
      modules: [
        {
          name: "SearchModule",
          className: "SearchModule",
          file: "src/search.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "SearchController",
              path: "/search",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/query",
                  handler: "search",
                  queryBindings: ["validQuery", "invalid#param", " "],
                },
              ],
              file: "src/search.controller.ts",
              importPath: "./search.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graphWithInvalidQuery);
    const invalidQueryDiags = diags.filter((d) => d.code === "invalid-query-param-name");
    expect(invalidQueryDiags.length).toBe(2);
    expect(invalidQueryDiags[0].errorCode).toBe("SC3013");
    expect(invalidQueryDiags[0].docsUrl).toBe("https://supacloud.dev/errors/SC3013");
    expect(invalidQueryDiags.some((d) => d.message.includes("illegal character"))).toBe(true);
    expect(invalidQueryDiags.some((d) => d.message.includes("empty @Query()"))).toBe(true);
  });

  test("detects missing token factory for InjectionToken (SC2009)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          file: "src/app.module.ts",
          line: 1,
          imports: [],
          providers: [
            {
              token: "AppService",
              tokenKind: "class",
              kind: "class",
              scope: "application",
              deps: ["CUSTOM_API_TOKEN"],
              file: "src/app.service.ts",
              line: 1,
              exported: true,
            },
          ],
          controllers: [],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const missingFactoryDiag = diags.find((d) => d.code === "missing-token-factory");
    expect(missingFactoryDiag).toBeDefined();
    expect(missingFactoryDiag?.errorCode).toBe("SC2009");
    expect(missingFactoryDiag?.suggestion).toContain("factory: () => ...");
  });

  test("detects invalid path param decorator names (SC3014)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          file: "src/app.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "BadParamController",
              path: "/items/:id",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/:id",
                  handler: "getItem",
                  pathParams: ["id"],
                  paramBindings: ["", "id#bad"],
                },
              ],
              file: "src/bad.controller.ts",
              importPath: "./bad.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const badParamDiags = diags.filter((d) => d.code === "unmatched-path-param-decorator");
    expect(badParamDiags.length).toBe(2);
    expect(badParamDiags[0].errorCode).toBe("SC3014");
  });

  test("detects invalid query parameter default values contradicting transforms (SC3015)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          file: "src/app.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "QueryController",
              path: "/search",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/",
                  handler: "search",
                  queryBindings: ["limit"],
                  queryTransforms: { limit: "number" },
                  queryDefaults: { limit: "not-a-number" },
                },
              ],
              file: "src/query.controller.ts",
              importPath: "./query.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const queryTypeDiag = diags.find((d) => d.code === "invalid-query-default-type");
    expect(queryTypeDiag).toBeDefined();
    expect(queryTypeDiag?.errorCode).toBe("SC3015");
    expect(queryTypeDiag?.message).toContain("is not a number");
  });

  test("detects disallowed body bindings on safe methods and DELETE (SC3016)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          file: "src/app.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "DeleteController",
              path: "/items",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "DELETE",
                  path: "/:id",
                  handler: "deleteItem",
                  hasBodyBinding: true,
                  body: "DeleteSchema",
                },
              ],
              file: "src/delete.controller.ts",
              importPath: "./delete.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const bodyDiag = diags.find((d) => d.code === "disallowed-body-on-get-delete");
    expect(bodyDiag).toBeDefined();
    expect(bodyDiag?.errorCode).toBe("SC3016");
    expect(bodyDiag?.message).toContain("HTTP DELETE");
  });

  test("detects duplicate query parameter bindings in route handler (SC3017)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "app",
          className: "AppModule",
          file: "src/app.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "SearchController",
              path: "/search",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/",
                  handler: "search",
                  queryBindings: ["filter", "filter"],
                },
              ],
              file: "src/search.controller.ts",
              importPath: "./search.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const dupQueryDiag = diags.find((d) => d.code === "duplicate-query-param-binding");
    expect(dupQueryDiag).toBeDefined();
    expect(dupQueryDiag?.errorCode).toBe("SC3017");
    expect(dupQueryDiag?.message).toContain("duplicate @Query('filter')");
  });

  test("detects mutating commands bound to read-only GET routes (SC4006)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "order",
          className: "OrderModule",
          file: "src/order.module.ts",
          line: 1,
          imports: [],
          providers: [],
          commands: [
            {
              className: "CreateOrderCommand",
              name: "order.create",
              transaction: "required",
              idempotency: "none",
            },
          ],
          controllers: [
            {
              className: "OrderController",
              path: "/orders",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/create",
                  handler: "create",
                  command: "CreateOrderCommand",
                },
              ],
              file: "src/order.controller.ts",
              importPath: "./order.controller",
            },
          ],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const mutatingCmdDiag = diags.find((d) => d.code === "command-transaction-readonly");
    expect(mutatingCmdDiag).toBeDefined();
    expect(mutatingCmdDiag?.errorCode).toBe("SC4006");
    expect(mutatingCmdDiag?.message).toContain("Mutating transactions are not permitted");
  });

  test("detects OpenAPI-style {param} in route paths (SC3019)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "users",
          className: "UsersModule",
          file: "src/users.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "UsersController",
              path: "/users",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/{id}",
                  handler: "getUser",
                },
              ],
              file: "src/users.controller.ts",
              importPath: "./users.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const curlyDiag = diags.find((d) => d.code === "missing-param-colon");
    expect(curlyDiag).toBeDefined();
    expect(curlyDiag?.errorCode).toBe("SC3019");
    expect(curlyDiag?.message).toContain("OpenAPI-style '{id}'");
    expect(curlyDiag?.suggestion).toContain("Replace '{id}' with ':id'");
  });

  test("warns when handler is mapped to multiple distinct HTTP methods (SC3018)", () => {
    const graph: ApplicationGraph = {
      modules: [
        {
          name: "items",
          className: "ItemsModule",
          file: "src/items.module.ts",
          line: 1,
          imports: [],
          providers: [],
          controllers: [
            {
              className: "ItemsController",
              path: "/items",
              scope: "request",
              deps: [],
              routes: [
                {
                  method: "GET",
                  path: "/item",
                  handler: "processItem",
                },
                {
                  method: "POST",
                  path: "/item",
                  handler: "processItem",
                },
              ],
              file: "src/items.controller.ts",
              importPath: "./items.controller",
            },
          ],
          commands: [],
          queries: [],
          exports: [],
        },
      ],
      externalTokens: [],
    };

    const diags = validateGraph(graph);
    const conflictDiag = diags.find((d) => d.code === "conflicting-route-method");
    expect(conflictDiag).toBeDefined();
    expect(conflictDiag?.errorCode).toBe("SC3018");
    expect(conflictDiag?.message).toContain("mapped to multiple HTTP methods");
  });
});
