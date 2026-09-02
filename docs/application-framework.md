# Application Framework

SupaCloud 应用框架为大型项目提供 Angular 风格的工程模型：**模块、依赖注入、作用域、命令/查询分层**，但通过静态编译消除运行时反射开销，并编译为 Elysia 插件在 Edge Runtime 上运行。

```
Angular 风格源代码（装饰器）
  -> @supacloud/compiler（AST 分析 + 依赖图 + 校验）
    -> 生成的静态工厂（无反射、无容器查找）
      -> @supacloud/elysia（Elysia 插件适配）
        -> Edge Runtime（framework: "elysia"）
```

## 包

| 包 | 职责 |
|---|---|
| `@supacloud/app` | 装饰器与元数据：`@Module` `@Injectable` `@Inject` `@Controller` `@Command` `@Query`、`InjectionToken`、Provider 类型、Scope、内置 Token（`DB_CLIENT`、`REQUEST_CONTEXT`、`JOB_CONTEXT`） |
| `@supacloud/compiler` | 静态编译器：依赖图、循环依赖/作用域/模块边界校验、静态工厂与 manifest 生成 |
| `@supacloud/elysia` | 把编译产物适配为 Elysia 插件，管理 application/request 作用域与路由校验，提供 `commandGovernance` 与 `composeCommandExecutors` 命令管道 |

## 编写业务模块

```ts
// features/case/case.module.ts
import { Module, DB_CLIENT } from "@supacloud/app";

@Module({
  name: "case",
  imports: [AuditModule],
  providers: [
    CaseService,
    { provide: CASE_REPOSITORY, useClass: DrizzleCaseRepository, deps: [DB_CLIENT] },
    AcceptCaseCommand,
  ],
  controllers: [CaseController],
  exports: [CaseService],
})
export class CaseModule {}
```

```ts
@Injectable()
export class CaseService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly repository: CaseRepository,
    private readonly audit: AuditService,
  ) {}
}

@Command({
  name: "case.accept",
  permission: "case.accept",
  transaction: "required",
  audit: "case.accepted",
  idempotency: "required",
})
export class AcceptCaseCommand { /* ... */ }

@Controller("/cases")
export class CaseController {
  constructor(private readonly acceptCase: AcceptCaseCommand) {}

  @Post("/:caseId/accept", {
    body: CaseAcceptInput,
    response: CaseAcceptResult,
    command: AcceptCaseCommand,
  })
  accept(ctx: { body: unknown; params: Record<string, string> }) {
    return this.acceptCase.execute(ctx.params.caseId, ctx.body);
  }
}
```

## 作用域规则

| Scope | 生命周期 | 允许依赖 |
|---|---|---|
| `application`（默认） | 整个 Function 实例 | 仅 `application` |
| `request` | 单次 HTTP 请求 | `application`、`request` |
| `job` | 单次后台任务 | `application`、`job` |

编译器在构建期拒绝作用域违规（如 application provider 依赖 request provider），防止用户/租户上下文泄漏到长生命周期对象。

内置 token：`DB_CLIENT`（数据库客户端，`application` 作用域）、`REQUEST_CONTEXT`（请求上下文，`request` 作用域）、`JOB_CONTEXT`（任务上下文，`job` 作用域），在对应作用域工厂中解析。

## 编译

```ts
import { compileProject } from "@supacloud/compiler";

const result = await compileProject({
  rootDir: ".",
  include: ["src/**/*.ts"],
  outDir: "generated",
  strict: true,
});
```

诊断码：`circular-dependency`、`scope-violation`、`module-boundary`、`unresolved-token`、`duplicate-token`、`duplicate-module`、`duplicate-command`、`duplicate-route`、`route-command-unresolved`、`command-missing-permission`（始终为 error）、`missing-deps`。

产物：

- `generated/application.ts`：拓扑序静态工厂 `createCompiledModules()`，纯 `new` 实例化
- `generated/app.manifest.json`：模块/Provider/路由/Command 清单，供 CLI 与部署治理使用

## 运行（Elysia）

```ts
import { composeCommandExecutors, createApplication, requireIdempotencyKey } from "@supacloud/elysia";
import { createCompiledModules } from "./generated/application";

export default createApplication({
  name: "fa-api",
  modules: createCompiledModules(),
  deps: { dbClient },
  commandGovernance: {
    authorize: async (invocation) => {
      await authorize(invocation.requestContext, invocation.command.permission);
    },
    idempotency: async (invocation, next) => {
      const key = requireIdempotencyKey(invocation);
      return idempotencyStore.run(key, next);
    },
    transaction: (invocation, next) => transactionManager.run(invocation, next),
    audit: {
      succeeded: (invocation, result) => auditLog.record(invocation, result),
      failed: (invocation, error) => auditLog.recordFailure(invocation, error),
    },
  },
  // 也可配置自定义洋葱管道 commandExecutor: composeCommandExecutors(...)
});
```

- application 级服务经 `.decorate()` 挂载，全实例共享
- request 级 provider 经 `.resolve()` 每请求新建，并发请求互不串扰
- 路由自动接 TypeBox body/params/query/response 校验（失败返回 422）
- 绑定 `command` 的路由必须配置 `commandGovernance` 或 `commandExecutor`；缺少治理配置时应用启动即失败（fail-closed）
- 治理链按授权 → 幂等 → 事务 → 业务处理 → 审计执行；具体存储和事务语义由平台适配器提供
- 可使用 `composeCommandExecutors` 灵活组合扩展中间件
- `errorMapper` 可把业务异常映射为统一错误协议
- 部署清单使用 `framework: "elysia"`，Edge Runtime 直接调用 `app.handle(request)`

## 大型项目迁移模式（Strangler）

不重写存量巨型 Function，而是逐垂直切片迁移：

1. 新模块写在 `features/<domain>/`（controller / command / query / repository / tests）
2. 编译产物以 Elysia 插件形式 `.use()` 挂载到现有入口
3. 旧路径优先、新插件兜底；验证响应契约一致后删除旧路由
4. 每个迁移完成的模块获得编译期依赖图与边界保护

## 测试

`@supacloud/testing` 提供：

- `createTestModule(meta, overrides)`：Provider 替换（fake repository、fake OCR provider 等）
- `testRequest` / `testJson` / `testJsonError`：HTTP 与统一错误协议测试
- `runSqlTests` / `assertPolicyAllows` / `assertPolicyDenies`：数据库与 RLS 测试

参见 [Database Governance](./database-governance.md)。
