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
});
