import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import type { ApplicationGraph, ModuleNode } from "./types";

let rootDir: string;
let graph: ApplicationGraph;

function moduleByName(name: string): ModuleNode {
  const module = graph.modules.find((m) => m.name === name);
  if (!module) throw new Error(`module not found: ${name}`);
  return module;
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-good-"));
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  graph = await analyzeProject(rootDir);
});

describe("analyzeProject：模块发现", () => {
  test("发现 @Module 装饰器模块与 defineModule 模块", () => {
    expect(graph.modules.map((m) => m.name).sort()).toEqual(["audit", "case", "health"]);
  });

  test("defineModule 模块：name 取 options.name，className 取变量名", () => {
    const health = moduleByName("health");
    expect(health.className).toBe("HealthModule");
    expect(health.file).toBe("src/features/health/health.module.ts");
    expect(health.providers.map((p) => p.token)).toEqual(["HealthService"]);
    expect(health.exports).toEqual(["HealthService"]);
  });

  test("imports 解析为被引用模块的 name", () => {
    expect(moduleByName("case").imports).toEqual(["audit"]);
  });

  test("tags 属性正确解析（无 tags 时为 undefined）", () => {
    expect(moduleByName("case").tags).toBeUndefined();
  });
});

describe("analyzeProject：provider 解析", () => {
  test("audit 模块：value / factory / class 三种 provider", () => {
    const audit = moduleByName("audit");
    expect(audit.providers.map((p) => p.token)).toEqual([
      "AUDIT_CONFIG",
      "LOGGER",
      "AUDIT_SERVICE",
    ]);

    const config = audit.providers[0];
    expect(config.kind).toBe("value");
    expect(config.tokenKind).toBe("injection-token");
    expect(config.useValueExpr).toBe('{ level: "info" }');
    expect(config.scope).toBe("application");

    const logger = audit.providers[1];
    expect(logger.kind).toBe("factory");
    expect(logger.useFactoryName).toBe("createLogger");
    expect(logger.importPath).toBe("src/features/audit/logger");
    expect(logger.deps).toEqual(["AUDIT_CONFIG"]);

    const service = audit.providers[2];
    expect(service.kind).toBe("class");
    expect(service.useClass).toBe("AuditService");
    expect(service.importPath).toBe("src/features/audit/audit.service");
    expect(service.deps).toEqual(["AUDIT_CONFIG", "LOGGER"]);
    expect(service.exported).toBe(true);
  });

  test("case 模块：裸类 provider、existing 别名、@Inject 依赖顺序", () => {
    const caseModule = moduleByName("case");
    expect(caseModule.providers.map((p) => p.token)).toEqual([
      "CASE_REPOSITORY",
      "CaseService",
      "CASE_SERVICE",
      "AcceptCaseCommand",
    ]);

    const repository = caseModule.providers[0];
    expect(repository.kind).toBe("class");
    expect(repository.useClass).toBe("DrizzleCaseRepository");
    expect(repository.deps).toEqual(["DB_CLIENT"]);

    const service = caseModule.providers[1];
    expect(service.tokenKind).toBe("class");
    expect(service.deps).toEqual(["CASE_REPOSITORY", "AUDIT_SERVICE"]);

    const alias = caseModule.providers[2];
    expect(alias.kind).toBe("existing");
    expect(alias.useExisting).toBe("CaseService");
    expect(alias.deps).toEqual(["CaseService"]);
  });

  test("exports 标记到 provider.exported", () => {
    const health = moduleByName("health");
    expect(health.providers[0].exported).toBe(true);
    expect(moduleByName("case").providers.every((p) => !p.exported)).toBe(true);
  });
});

describe("analyzeProject：controller 与路由", () => {
  test("controller 默认 request scope，deps 含 REQUEST_CONTEXT", () => {
    const caseModule = moduleByName("case");
    expect(caseModule.controllers).toHaveLength(1);
    const controller = caseModule.controllers[0];
    expect(controller.className).toBe("CaseController");
    expect(controller.path).toBe("/cases");
    expect(controller.scope).toBe("request");
    expect(controller.deps).toEqual(["CASE_REPOSITORY", "AUDIT_SERVICE", "REQUEST_CONTEXT"]);
    expect(controller.importPath).toBe("src/features/case/case.controller");
  });

  test("路由收集方法装饰器与 schema 符号及其 import 路径", () => {
    const controller = moduleByName("case").controllers[0];
    expect(controller.routes).toHaveLength(1);
    expect(controller.routes[0]).toEqual({
      method: "POST",
      path: "/:caseId/accept",
      handler: "accept",
      body: "CreateCaseBody",
      params: "AcceptParams",
      response: "AcceptResult",
      command: "AcceptCaseCommand",
      pathParams: ["caseId"],
    });
    expect(controller.schemaImports).toEqual({
      CreateCaseBody: "src/features/case/contracts",
      AcceptParams: "src/features/case/contracts",
      AcceptResult: "src/features/case/contracts",
    });
  });

  test("analyzes HEAD and OPTIONS route decorators", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-compiler-http-methods-"));
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/status.module.ts": `import { Controller, Head, Module, Options } from "./runtime";

@Controller("/status")
class StatusController {
  @Head("/")
  head() {}

  @Options("/")
  options() {}
}

@Module({ name: "status", controllers: [StatusController] })
export class StatusModule {}
`,
    });

    const status = (await analyzeProject(root)).modules[0];
    expect(status.controllers[0]?.routes.map((route) => route.method)).toEqual(["HEAD", "OPTIONS"]);
  });
});

describe("analyzeProject：command 与 externalTokens", () => {
  test("@Command 全元数据进入 commands 节点", () => {
    const commands = moduleByName("case").commands;
    expect(commands).toEqual([
      {
        className: "AcceptCaseCommand",
        name: "case.accept",
        permission: "case.accept",
        transaction: "required",
        audit: "case.accepted",
        idempotency: "required",
      },
    ]);
  });

  test("无 provider 的依赖 token 记入 externalTokens", () => {
    expect(graph.externalTokens).toEqual(["DB_CLIENT", "REQUEST_CONTEXT"]);
  });

  test("正常项目无诊断", () => {
    expect(graph.diagnostics ?? []).toEqual([]);
  });

  test("analyzes property-level inject() dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-inject-prop-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.service.ts": `
        import { Injectable, inject, InjectionToken } from "@supacloud/app";
        const CONFIG = new InjectionToken<string>("config");
        const CACHE = new InjectionToken<string>("cache");

        @Injectable({ providedIn: 'root' })
        export class StandaloneService {
          private config = inject(CONFIG);
          private cache = inject(CACHE, { optional: true });
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const prov = rootMod?.providers.find((p) => p.token === "StandaloneService");
    expect(prov?.deps).toContain("CONFIG");
    expect(prov?.deps).toContain("CACHE");
    expect(prov?.optionalDeps).toContain("CACHE");
  });

  test("analyzes canMatch guards, param transforms/defaults, and onDestroy hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-angular-dx-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.controller.ts": `
        import { Controller, Get, Param, Query, Injectable, OnDestroy } from "@supacloud/app";

        @Injectable({ providedIn: 'root' })
        export class LifecycleService implements OnDestroy {
          onDestroy(): void {}
        }

        @Controller({ path: "/items", standalone: true })
        export class ItemsController {
          @Get("/:id", { canMatch: ["FeatureMatchGuard"] })
          getItem(
            @Param({ name: "id", transform: "number" }) id: number,
            @Query({ name: "limit", transform: "number", default: 20 }) limit: number,
          ) {
            return { id, limit };
          }
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    expect(rootMod).toBeDefined();

    const prov = rootMod?.providers.find((p) => p.token === "LifecycleService");
    expect(prov?.hasOnDestroy).toBe(true);

    const ctrl = rootMod?.controllers.find((c) => c.className === "ItemsController");
    expect(ctrl).toBeDefined();
    expect(ctrl?.routes[0].canMatch).toEqual(["FeatureMatchGuard"]);
    expect(ctrl?.routes[0].paramTransforms).toEqual({ id: "number" });
    expect(ctrl?.routes[0].queryTransforms).toEqual({ limit: "number" });
    expect(ctrl?.routes[0].queryDefaults).toEqual({ limit: 20 });
  });

  test("unwraps forwardRef in @Inject, useClass, and provider tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-forwardref-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.service.ts": `
        import { Injectable, Inject, Module, forwardRef, InjectionToken } from "@supacloud/app";

        export const SERVICE_TOKEN = new InjectionToken<string>("service-token");

        @Injectable()
        export class FirstService {
          constructor(@Inject(forwardRef(() => SecondService)) private second: unknown) {}
        }

        @Injectable()
        export class SecondService {
          constructor(private first: FirstService) {}
        }

        @Module({
          name: "forwardRefModule",
          providers: [
            FirstService,
            SecondService,
            {
              provide: forwardRef(() => SERVICE_TOKEN),
              useClass: forwardRef(() => FirstService),
            },
          ],
        })
        export class ForwardRefModule {}
      `,
    });

    const analyzed = await analyzeProject(root);
    const mod = analyzed.modules.find((m) => m.name === "forwardRefModule");
    expect(mod).toBeDefined();

    const first = mod?.providers.find((p) => p.token === "FirstService");
    expect(first?.deps).toEqual(["SecondService"]);

    const alias = mod?.providers.find((p) => p.token === "SERVICE_TOKEN");
    expect(alias).toBeDefined();
    expect(alias?.useClass).toBe("FirstService");
  });

  test("analyzes route title and data metadata from options and decorators", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-route-metadata-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.controller.ts": `
        import { Controller, Get, Title, Data } from "@supacloud/app";

        @Controller({ path: "/docs", standalone: true })
        export class DocsController {
          @Get("/overview", { title: "Documentation Overview", data: { auth: false, version: 2 } })
          getOverview() {}

          @Get("/advanced")
          @Title("Advanced Guides")
          @Data({ auth: true, tier: "pro" })
          getAdvanced() {}
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const ctrl = rootMod?.controllers.find((c) => c.className === "DocsController");
    expect(ctrl).toBeDefined();
    expect(ctrl?.routes[0].title).toBe("Documentation Overview");
    expect(ctrl?.routes[0].data).toEqual({ auth: false, version: 2 });
    expect(ctrl?.routes[1].title).toBe("Advanced Guides");
    expect(ctrl?.routes[1].data).toEqual({ auth: true, tier: "pro" });
  });

  test("analyzes property-level inject with self, skipSelf, and host flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-inject-modifiers-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.service.ts": `
        import { Injectable, inject, InjectionToken } from "@supacloud/app";
        const LOCAL_SVC = new InjectionToken<string>("local");
        const PARENT_SVC = new InjectionToken<string>("parent");
        const HOST_SVC = new InjectionToken<string>("host");

        @Injectable({ providedIn: 'root' })
        export class ScopedService {
          private local = inject(LOCAL_SVC, { self: true });
          private parent = inject(PARENT_SVC, { skipSelf: true });
          private host = inject(HOST_SVC, { host: true });
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const prov = rootMod?.providers.find((p) => p.token === "ScopedService");
    expect(prov?.selfDeps).toContain("LOCAL_SVC");
    expect(prov?.skipSelfDeps).toContain("PARENT_SVC");
    expect(prov?.hostDeps).toContain("HOST_SVC");
  });

  test("analyzes canDeactivate guards on controller routes from options and decorator", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-candeactivate-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/test.controller.ts": `
        import { Controller, Get, CanDeactivate } from "@supacloud/app";

        @Controller({ path: "/orders", standalone: true })
        export class OrdersController {
          @Get("/checkout", { canDeactivate: ["PendingPaymentGuard"] })
          checkout() {}

          @Get("/draft")
          @CanDeactivate("UnsavedChangesGuard")
          draft() {}
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const ctrl = rootMod?.controllers.find((c) => c.className === "OrdersController");
    expect(ctrl).toBeDefined();
    expect(ctrl?.routes[0].canDeactivate).toEqual(["PendingPaymentGuard"]);
    expect(ctrl?.routes[1].canDeactivate).toEqual(["UnsavedChangesGuard"]);
  });

  test("synthesizes root factory provider with importPath for tree-shakable InjectionToken", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-token-factory-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/tokens.ts": `
        import { InjectionToken } from "@supacloud/app";
        export const API_ENDPOINT = new InjectionToken<string>("api-endpoint", {
          providedIn: "root",
          factory: () => "https://api.supacloud.local",
        });
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const prov = rootMod?.providers.find((p) => p.token === "API_ENDPOINT");
    expect(prov).toBeDefined();
    expect(prov?.tokenKind).toBe("injection-token");
    expect(prov?.kind).toBe("factory");
    expect(prov?.importPath).toBe("src/tokens");
  });

  test("analyzes @Resolve decorator on controller methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-resolve-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/resolver.controller.ts": `
        import { Controller, Get, Resolve } from "@supacloud/app";

        const UserResolver = (ctx: { userId: string }) => ({ id: ctx.userId });
        const OrgResolver = (ctx: { orgId: string }) => ({ id: ctx.orgId });

        @Controller({ path: "/accounts", standalone: true })
        export class AccountsController {
          @Get("/:id")
          @Resolve({ user: UserResolver, org: OrgResolver })
          getAccount() {}
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const ctrl = rootMod?.controllers.find((c) => c.className === "AccountsController");
    expect(ctrl).toBeDefined();
    expect(ctrl?.routes[0].resolvers).toEqual({
      user: "UserResolver",
      org: "OrgResolver",
    });
  });

  test("automatically infers route parameter bindings and transforms from method signature (withComponentInputBinding)", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-input-binding-"));
    await writeFixtureProject(root, {
      "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"],
      "src/auto_binding.controller.ts": `
        import { Controller, Get, Query } from "@supacloud/app";

        @Controller({ path: "/inventory", standalone: true })
        export class InventoryController {
          @Get("/:itemId/details/:subId")
          getItem(itemId: string, subId: number, @Query("format") format: string) {}
        }
      `,
    });

    const analyzed = await analyzeProject(root);
    const rootMod = analyzed.modules.find((m) => m.name === "root");
    const ctrl = rootMod?.controllers.find((c) => c.className === "InventoryController");
    expect(ctrl).toBeDefined();
    const route = ctrl?.routes[0];
    expect(route?.pathParams).toEqual(["itemId", "subId"]);
    expect(route?.paramBindings).toEqual(["itemId", "subId"]);
    expect(route?.paramTransforms?.["subId"]).toBe("number");
    expect(route?.queryBindings).toEqual(["format"]);
  });
});

describe("analyzeProject：Angular Provider 类型契约", () => {
  test("useClass 与 InjectionToken<T> 不兼容时生成静态诊断", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-compiler-provider-class-type-"));
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/provider.ts": `
        import { InjectionToken, Module } from "./runtime";

        interface Repository {
          find(id: string): Promise<string>;
        }

        const REPOSITORY = new InjectionToken<Repository>("repository");

        class WrongRepository {
          find(id: string): string {
            return id;
          }
        }

        @Module({
          name: "provider",
          providers: [{ provide: REPOSITORY, useClass: WrongRepository }],
        })
        export class ProviderModule {}
      `,
    });

    const analyzed = await analyzeProject(root);
    const diagnostic = analyzed.diagnostics?.find((item) => item.code === "provider-type-mismatch");
    expect(diagnostic).toMatchObject({
      severity: "error",
      errorCode: "SC2010",
      docsUrl: "https://supacloud.dev/errors/SC2010",
    });
    expect(diagnostic?.message).toContain("REPOSITORY");
    expect(diagnostic?.message).toContain("useClass");
  });

  test("useValue 与 InjectionToken<T> 不兼容时生成静态诊断", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-compiler-provider-value-type-"));
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/provider.ts": `
        import { InjectionToken, Module } from "./runtime";

        const CONFIG = new InjectionToken<{ retries: number }>("config");

        @Module({
          name: "provider",
          providers: [{ provide: CONFIG, useValue: { retries: "three" } }],
        })
        export class ProviderModule {}
      `,
    });

    const analyzed = await analyzeProject(root);
    const diagnostic = analyzed.diagnostics?.find((item) => item.code === "provider-type-mismatch");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("CONFIG");
    expect(diagnostic?.message).toContain("useValue");
  });
});
