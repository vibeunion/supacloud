# 静态 AOP 的参考与边界

状态：**FROZEN**。已实现的静态切面与 Angular 风格 DI 契约停在当前语义。
不要新增运行时切点、方法代理、反射容器，也不要新增 Forms、signals、HttpClient
或 injector 示例。`@angular/core` 仍是 `@supacloud/app` 的打包期 external，
本冻结不删除它。`createApplication` 没有 `injector` 字段。
日常功能开发从[功能迭代手册](../feature-development.md)进入。

## 决策

SupaCloud 的主参考固定为：**AOP 编译架构参考 Micronaut，业务组织参考 NestJS，
DI 语义参考 Angular**。三者分别指导编译、模块归属与依赖解析，不引入新的服务端
框架运行时，也不承诺完整 API 兼容。AdonisJS 仅作 HTTP 开发体验的补充参考；
现有 Elysia 继续承担 HTTP 宿主。

| 主参考 | 实施内容 | 明确边界 |
| --- | --- | --- |
| Micronaut | 语义分析、依赖图校验、生成直接工厂和固定切面调用链；错误在产物生成前报告 | 不照搬 JVM 代理类或透明方法拦截 |
| NestJS | 按业务功能组织 Module/Provider/Controller；模块默认私有，显式 exports/re-exports | TypeBox、HTTP policy、Effect 错误契约和 Command 沿用现有职责，不增加 RxJS 执行层 |
| Angular | 构造参数 Token、Optional/Self/SkipSelf、root 默认值、alias/multi、作用域与销毁 | 使用静态服务端作用域；不引入 DOM injector、运行时 inject() 或隐式 scope 冒泡 |

Angular 的运行时兼容适配层仍然存在。编译后的服务端请求路径使用显式工厂，
与兼容层的运行时 injector API 是不同入口。本决策不删除或替换兼容层。

## 已实施的静态服务端 DI 语义

验证、工厂生成与 executionPlan 共用同一个依赖解析器。跨模块只能沿显式导出解析，
可以重导出 Token 或已导入的 Module；菱形路径保留原始实例，两个不同来源则报
`SC2013`，不能依靠 imports 顺序偶然选中。Controller 与 Provider 执行相同门禁。

| 声明 | 生成行为 |
| --- | --- |
| 普通构造参数 | 本模块 → 公开 imports → root 默认 provider → 显式平台 Token |
| `@Self()` | 只解析当前作用域，不向 application 父作用域或 imports 回退 |
| `@SkipSelf()` | 跳过当前作用域；request/job 可使用所属模块的 application 父作用域，然后公开 imports/root/platform |
| `@Optional()` | 无可见绑定时返回 `null`；不放宽作用域、歧义或循环依赖规则 |
| 同 Token 的多个参数 | 按参数索引分别解析修饰符；同一参数 Self + SkipSelf 报 `SC2014` |
| `useExisting` | 复用原实例或同一个 multi 数组，不重复构造/销毁 |
| `multi: true` | 所有贡献按声明顺序组成数组，先完成全部贡献再构造消费者；混合 scope 报 `SC2016` |
| `providedIn: "root"` | 自动默认 provider 独立于 app 的 feature imports 初始化；隐式依赖也参与循环检查 |

application 不能持有 request/job 实例；request 与 job 是兄弟作用域，也不能互相注入。
跨模块借用 request/job provider 报 `SC2015`：把它留在所属 feature，通过 application
端口显式传递身份和业务数据。当前静态 profile 不实现跨模块 scope 冒泡。
`@Host()` 保留语义元数据，但没有 DOM 宿主边界。

平台 Token 必须是依赖对象的自有属性；必需绑定缺失时抛出
`COMPILED_DEPENDENCY_MISSING`，继承属性不能满足绑定。显式绑定的 `undefined`
保留原值，Optional 只处理不存在的绑定。请求/任务 scope 并发隔离，构造失败逆序
清理已创建对象；scope 和 application 的销毁均去重，重复调用不再执行 hook。

typed aspect 必须使用 `const` 静态引用，契约使用字面量且不含 spread；操作 kind/name
必须与绑定位置一致，否则报 `SC4030`。路由名为 `METHOD /完整路径`，module 通用
切面使用普通函数。这些结构错误以及无效 DI 图不能通过 `writeOnError` 生成产物。

升级时重新编译全部受影响应用；把 Optional 的缺失判断由 `undefined` 改为 `null`
并声明可空类型，清理依赖旧 imports 顺序或跨模块 scope 借用的代码。不要手改
生成文件。回归证据见 [framework-architecture.test.ts](../../packages/compiler/src/framework-architecture.test.ts)。

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

1. **显式绑定。** 使用函数引用或 `defineOperationAspect` 静态工厂声明的引用；
   工厂的 `kind`、`name` 使用字面量，顺序写在声明中，第一项在最外层。
   不按字符串方法名、运行时扫描或 Proxy 自动匹配方法。
2. **只执行一次。** 正常路径 `return next()` 或 `return await next()`；拒绝必须抛错。
   不重用、保存、后台延迟调用 `next`，不在切面中重试业务处理器。
3. **保留业务边界。** Command 切面在已授权的业务 continuation 内运行；
   不创建第二个 receipt、事务或审计账本，不伪造成功回执。
4. **依赖明确。** 请求和任务身份不能保存在 application 单例中。普通领域服务
   通过构造器获得端口；不从任意代码位置查容器。
5. **结果与失败明确。** 不吞掉业务错误，不把 `unknown` 写结果改成成功；
   公开错误映射使用已有 Effect/协议契约。遥测只记录有界元数据。
6. **不透明拦截普通方法。** 普通 TypeScript 函数仍是普通调用，需要治理的动作
   显式进入 executor。这样调用图和失败边界能够被编译器与评审者检查。

Effect 是复杂执行的组合和错误模型；简单的非 Command CRUD 读可以使用 `effect: false`
返回 Promise，纯计算保持 TypeScript。不要为了模仿
Nest interceptor 再把 RxJS 加到服务端命令管线。数据库模型和策略由 ZenStack
负责，驱动由 Bun SQL 负责，两者均不承担切面编排。

## 当前强制能力与缺口

| 能力 | 当前证据 / 限制 |
| --- | --- |
| 模块导出、逐参数 DI、root/multi/alias、清理和 typed aspect 静态绑定 | `framework-architecture.test.ts`，生成 TypeScript 校验与运行验证 |
| 显式切面引用、静态调用顺序、作用域隔离 | `static-di-aop.test.ts`，生成 `aspectPipeline` |
| continuation 单次使用、关闭后失效与等待已开始工作 | [execution 实现契约](../../packages/app/EXECUTION.md#execution-guarantees-and-limits) |
| 类型可见的裸 Command 调用检查 | `SC4029`；不是全程序信息流或安全沙箱 |
| 执行计划、路由注册及适配器能力校验 | `executionPlan`、`registerRoutes`、`validateExecutionManifest`；元数据不证明运行时持久化 |
| 原始模型客户端不进入业务层 | 源导入门禁及只读/事务 facade；可信 host 仍须正确验证身份 |
| 操作专属输入、结果与 capability | `defineOperationAspect` 通过输入/结果校验器和显式 capability 选择器推导类型；回调没有开放 services、原始 Request 或任意身份切换入口 |
| Command 切面保留业务执行结果 | portable、Elysia 和编译管线都要求成功返回来自一次 next；拒绝替换结果、吞掉下游失败及捕获后继续的重复 next |
| HTTP/Worker 模型命令模板 | `app init --template model-command`；同一 durable facade、编译切面、身份解析与原子 receipt/audit |

typed 回调接收输入的冻结副本；结果必须保持同一值/引用，普通对象和数组递归冻结。
Command 业务切面结果中的 Date、Response、类实例、访问器、函数和循环对象会被拒绝；
先转成契约数据，再在协议层构造响应。结果校验器只能缩窄类型，不能转换结果。
HTTP 协议包装仍可透传处理器返回的原生 Response、状态、头和流；它继续校验
continuation、结果身份和失败，不能由路由切面跳过处理器或替换成功响应。
route/job 切面仍可短路或映射；进入绑定 Command 的 HTTP 路由后，整个业务切面链
仍须保留处理器结果。handler 自行调用 durable facade 的路由，其 HTTP 包装仍属于
协议层；将业务切面放在 facade 的事务内，不能把外层 HTTP 映射当作持久化保证。

校验器和 capability 选择器是可信边界，类型检查不是 JavaScript 安全沙箱；
显式授予的能力仍须正确实现。切面不能撤销适配器自行提前提交或远端副作用。
证据集中在 [model-command 回归](../../packages/cli/src/shared/tools/app-model-command-starter.test.ts)，
真实 PostgreSQL 用例需设置 `SUPACLOUD_STARTER_POSTGRES_BIN`。它验证 HTTP/Worker
处理器，不宣称完整 PGMQ 调度或生产部署验收。无需新建平行的 guard/pipe/filter 注册系统。

## 实现与官方参考

- [SupaCloud application execution](../../packages/app/EXECUTION.md)
- [编译切面回归](../../packages/compiler/src/static-di-aop.test.ts)
- [编译执行契约回归](../../packages/compiler/src/execution-contract.test.ts)
- [Angular hierarchical DI](https://angular.dev/guide/di/hierarchical-dependency-injection)：Token 查找与 Self/SkipSelf/Optional 的语义参考。
- [NestJS modules](https://docs.nestjs.com/modules)：feature 模块和公开 provider 组织。
- [Angular functional interceptors](https://angular.dev/guide/http/interceptors)：官方推荐显式函数 interceptor，并说明按配置顺序组成链。
- [NestJS interceptors](https://docs.nestjs.com/interceptors)：处理器执行上下文和 RxJS CallHandler 边界。
- [AdonisJS middleware](https://docs.adonisjs.com/guides/basics/middleware)：server/router/named 三类 HTTP middleware。
- [Micronaut AOP](https://docs.micronaut.io/5.2.x/core/#core-aop)：编译期 AOP 的设计参考，不作为 SupaCloud 运行时依赖。
