# @supacloud/app

[English](#english) | [中文](#中文)

## English

Angular-style application metadata for SupaCloud applications: modules, DI
tokens, providers, scopes, controllers and commands.

This package is **metadata only**. Decorators attach metadata to classes; the
SupaCloud compiler (`@supacloud/compiler`) reads that metadata from source,
validates the dependency graph and generates plain static factories — there is
no runtime reflection and no `reflect-metadata` dependency.

```ts
import {
  Command,
  Controller,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Post,
} from "@supacloud/app";

export const CASE_REPOSITORY = new InjectionToken<CaseRepository>("case.repository");

@Injectable()
export class CaseService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly repository: CaseRepository,
  ) {}
}

@Command({ name: "case.accept", permission: "case.accept", transaction: "required" })
export class AcceptCaseCommand {
  constructor(private readonly cases: CaseService) {}
}

@Controller("/cases")
export class CaseController {
  constructor(private readonly acceptCase: AcceptCaseCommand) {}

  @Post("/:caseId/accept", { body: CaseAcceptInput })
  accept() {
    return this.acceptCase.execute();
  }
}

@Module({
  name: "case",
  providers: [
    CaseService,
    { provide: CASE_REPOSITORY, useClass: DrizzleCaseRepository },
    AcceptCaseCommand,
  ],
  controllers: [CaseController],
  exports: [CaseService],
})
export class CaseModule {}
```

## Scopes

| Scope | Lifetime | May depend on |
|---|---|---|
| `application` (default) | whole function instance | `application` only |
| `request` | one HTTP request | `application`, `request` |
| `job` | one background task | `application`, `job` |

The compiler rejects scope violations (e.g. an `application` provider
depending on a `request` provider) at build time.

## Non-decorator usage

`defineModule(options)` produces the same metadata as `@Module(options)` and
can be used where decorators are not enabled.

## 中文

`@supacloud/app` 为 SupaCloud 应用提供类似 Angular 的应用元数据能力，包含模块、依赖注入 token、provider、生命周期 scope、controller 和 command。

本包只负责保存元数据。装饰器把信息附加到类上，由 `@supacloud/compiler` 从源码中读取、校验依赖图并生成普通的静态工厂；运行时不依赖反射，也不需要 `reflect-metadata`。

### Scope

| Scope | 生命周期 | 可依赖 |
|---|---|---|
| `application`（默认） | 整个 Function 实例 | 仅 `application` |
| `request` | 一个 HTTP 请求 | `application`、`request` |
| `job` | 一个后台任务 | `application`、`job` |

编译器会在构建阶段拒绝 scope 违规，例如 `application` provider 依赖 `request` provider。

### 不使用装饰器

当项目未启用装饰器时，可以使用 `defineModule(options)`，它会生成与 `@Module(options)` 相同的元数据。

上面的英文示例代码可直接用于中文文档中的 API 说明。
