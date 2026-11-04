# 静态 AOP 的参考与边界

状态：架构选择与开发约束；下文明确区分已有实现和后续强化方向。
日常功能开发从[功能迭代手册](../feature-development.md)进入。

## 决策

SupaCloud 保持显式、可检查的编译执行模型。AOP 实现方向优先参考 Micronaut
的编译期解析和代码生成；借鉴 Angular 的 DI/生命周期和显式函数链，NestJS
的服务端职责划分，以及 AdonisJS 的 HTTP 生命周期与开发约定。
不承诺四者的 API 兼容，也不为这个设计引入新运行时。

Angular 不是完整的服务端 AOP 规范。它的 HTTP interceptor 作用于 HttpClient；
不能直接决定服务端事务、持久回执或后台任务的执行语义。Nest interceptor
围绕框架处理器运行，也不意味着普通 service 方法自动被拦截。

| 参考 | 借鉴内容 | SupaCloud 的取舍 |
| --- | --- | --- |
| Angular | Token、DI 作用域、销毁语义、按声明顺序执行的函数 interceptor | 编译入口使用构造器工厂；不把浏览器路由守卫或动态 `inject()` 带入编译业务路径 |
| NestJS | Module/Provider/Controller，guard、pipe、interceptor、filter 的职责分离 | 映射为现有声明、TypeBox、HTTP policy、静态切面及错误契约；不再叠加反射容器或 RxJS 执行层 |
| AdonisJS | HTTP middleware 层次、显式路由绑定、脚手架与生命周期约定 | 由 Elysia 宿主与现有 CLI 承担；不引入 Lucid 或新的容器/迁移系统 |
| Micronaut | 在编译期解析 DI/AOP，提前发现结构错误，生成执行代码 | 学习编译时处理原则；保留直接函数调用，不照搬 JVM 代理类或透明方法级拦截 |

Angular 的运行时兼容适配层仍然存在。编译后的服务端请求路径使用显式工厂，
与兼容层的运行时 injector API 是不同入口。本决策不删除或替换兼容层。

## 只有一套业务执行边界

HTTP 的解析、协议校验、响应映射、限流和访问日志由 Elysia 宿主负责。
Command executor 与 durable adapter 负责业务权限、幂等、事务、审计和恢复。
静态切面只在显式 module/route/command/job 边界包装行为。

```text
HTTP / Worker / 可信 CLI
  → 入口契约与可信身份
  → 受治理的 Command 入口
      → 当前权限 / receipt / 事务适配器
      → 显式业务切面与处理器
          → 领域函数 + transaction.db
      → receipt + audit 与业务变更原子提交
  → 入口的结果或错误映射
```

图表示本地数据库命令的职责，不规定所有适配器使用相同 SQL 顺序。直接持久化
命令可以在事务中完成锁定和授权；编译执行管线按其已声明阶段调用端口。以实际
生成计划和适配器为准。`route` 和 `handler` 两类 commandBoundary 也不同，
不能把处理器内授权描述成覆盖了整个 HTTP 请求。外部命令使用 intent/reconcile。

不要把鉴权、幂等、事务、业务审计各做成可任意排列的用户切面。更不要在
`await next()` 后向独立连接写业务审计；这无法与业务变化原子提交。
观测事件使用现有 `ExecutionObserver` / `onExecution`，不代表持久业务审计。

## 切面的开发规则

1. **显式绑定。** 使用编译器支持的函数引用；顺序写在声明中，第一项在最外层。
   不按字符串方法名、运行时扫描或 Proxy 自动匹配方法。
2. **只执行一次。** 正常路径 `return next()` 或 `return await next()`；拒绝可不调用。
   不重用、保存、后台延迟调用 `next`，不在切面中重试业务处理器。
3. **保留业务边界。** Command 切面在已授权的业务 continuation 内运行；
   不创建第二个 receipt、事务或审计账本，不伪造成功回执。
4. **依赖明确。** 请求和任务身份不能保存在 application 单例中。普通领域服务
   通过构造器获得端口；不从任意代码位置查容器。
5. **结果与失败明确。** 不吞掉业务错误，不把 `unknown` 写结果改成成功；
   公开错误映射使用已有 Effect/协议契约。遥测只记录有界元数据。
6. **不透明拦截普通方法。** 普通 TypeScript 函数仍是普通调用，需要治理的动作
   显式进入 executor。这样调用图和失败边界能够被编译器与评审者检查。

Effect 是单次执行的组合和错误模型；纯计算保持 TypeScript。不要为了模仿
Nest interceptor 再把 RxJS 加到服务端命令管线。数据库模型和策略由 ZenStack
负责，驱动由 Bun SQL 负责，两者均不承担切面编排。

## 当前强制能力与缺口

| 能力 | 当前证据 / 限制 |
| --- | --- |
| 显式切面引用、静态调用顺序、作用域隔离 | `static-di-aop.test.ts`，生成 `aspectPipeline` |
| continuation 单次使用、关闭后失效与等待已开始工作 | [execution 实现契约](../../packages/app/EXECUTION.md#execution-guarantees-and-limits) |
| 类型可见的裸 Command 调用检查 | `SC4029`；不是全程序信息流或安全沙箱 |
| 执行计划、路由注册及适配器能力校验 | `executionPlan`、`registerRoutes`、`validateExecutionManifest`；元数据不证明运行时持久化 |
| 原始模型客户端不进入业务层 | 源导入门禁及只读/事务 facade；可信 host 仍须正确验证身份 |
| 参数/结果/错误的细粒度切面类型 | 当前 `AspectContext` 仍含 `unknown` 和开放记录，未实现操作专属 capability 类型 |
| 切面不能伪造成功或绕过业务处理 | 当前单次 `next` 检查不证明此语义；现由约束、评审及行为测试保证 |

下一步优先补一份经过 HTTP 与 Worker 验证的全模型业务模板，再针对真实使用
需求收紧 Aspect 输入和能力类型。不要先增加一套 guard/pipe/filter/aspect 的
平行注册系统，也不要把“完整参考某框架”作为无边界重构目标。

## 实现与官方参考

- [SupaCloud application execution](../../packages/app/EXECUTION.md)
- [编译切面回归](../../packages/compiler/src/static-di-aop.test.ts)
- [编译执行契约回归](../../packages/compiler/src/execution-contract.test.ts)
- [Angular functional interceptors](https://angular.dev/guide/http/interceptors)：官方推荐显式函数 interceptor，并说明按配置顺序组成链。
- [NestJS interceptors](https://docs.nestjs.com/interceptors)：处理器执行上下文和 RxJS CallHandler 边界。
- [AdonisJS middleware](https://docs.adonisjs.com/guides/basics/middleware)：server/router/named 三类 HTTP middleware。
- [Micronaut AOP](https://docs.micronaut.io/5.2.x/core/#core-aop)：编译期 AOP 的设计参考，不作为 SupaCloud 运行时依赖。
