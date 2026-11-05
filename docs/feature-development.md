# 功能迭代开发手册

本手册是后续人工和 AI 功能开发的入口。架构决策见
[静态 AOP 设计](architecture/static-aop.md)，存量应用升级见
[ZenStack 迁移方案](architecture/zenstack-upgrade.md)。包版本以项目 manifest、
lockfile 和已发布的匹配版本为准；升级分支中的实现不代表 npm 已发布。

## 一项功能的职责分配

| 变更 | 维护位置 | 必须保留的边界 |
| --- | --- | --- |
| 请求、响应和公开错误 | 功能内 TypeBox 契约与路由 Effect 声明 | 不直接把数据库行类型作为公开 API |
| 表、字段、关系和数据访问策略 | `zenstack/schema.zmodel` | 生成模型类型，禁止手改生成物 |
| 状态转换、金额计算和业务判断 | 功能内领域函数 / Command | 纯计算保持普通 TypeScript |
| 服务端模型查询 | 可信身份绑定的只读 `models` | 不取得写权限、原始 SQL 或身份切换能力 |
| 业务写入 | 持久化 Command 的 `transaction.db` | 业务变化、receipt、audit 同一事务 |
| 跨入口权限、幂等和恢复 | 现有 Command executor / durable adapter | HTTP、Worker、CLI 复用业务操作 |
| 通用执行包装 | 显式静态 AOP | 不另开事务、不另记业务审计、不自动重试写入 |
| 类型化错误、依赖和取消 | Effect 程序及声明 | 生产解释器归框架适配器，取消不等于回滚 |
| 连接池、身份验证、特殊 SQL | 可信 host / adapter | 不向普通业务模块导出底层客户端 |
| RLS、函数、触发器、特殊约束 | 受治理的 SQL 源和正向迁移 | 与模型协调，继续使用唯一迁移账本 |

Command 权限决定“能否执行此业务动作”，ZenStack policy 决定“能访问哪些记录”。
数据库约束保证数据不变量。PostgREST/RPC 继续由数据库角色与 RLS 保护，不能
因为新增了 ZenStack policy 就移除这些保护。

## 按功能组织代码

沿用项目现有目录。下面仅表示归属，不要求为每项小功能建立全部文件：

```text
src/orders/
  contracts.ts          # 输入、响应、公开错误
  rules.ts              # 纯领域规则
  approve.command.ts    # 审批业务与已有持久化 executor 的绑定
  orders.controller.ts  # HTTP 协议适配
  orders.module.ts      # providers、exports、静态 aspects
src/host/               # 可信身份、连接、适配器装配
zenstack/schema.zmodel  # 模型和数据策略
zenstack/generated/    # 自动生成
db/modules.ts          # 数据库对象归属
db/contracts/          # 自动生成的源契约
migrations/            # 只追加的已审查迁移
```

不为每个模型机械增加 Repository、Service、Controller。只有需要替换外部系统、
复用业务规则或明确隔离基础设施时才新增端口。

后续功能遵循三个固定参考：Micronaut 的编译分析与直接生成、NestJS 的 feature
模块组织、Angular 的构造器 DI。模块通过 exports 公开应用端口，需要转发时显式
重导出。request/job provider 留在本 feature；跨 feature 传递身份与数据，不能注入
另一个 feature 的短生命周期实例。Optional 参数使用 `T | null`，Self/SkipSelf
按参数选择；不要通过 imports 排列解决 Token 冲突。详细语义与升级说明见
[静态 DI profile](architecture/static-aop.md#已实施的静态服务端-di-语义)。

## 从需求到交付

1. **定义业务动作。** 写清输入/结果、当前权限、状态转换、并发冲突、幂等键以及
   失败后的可观察结果。需要事务的本地变化和远端副作用分别列出。
2. **维护数据与契约。** 修改 ZModel、TypeBox 契约和必要的 SQL 约束。角色和租户
   来自可信身份；不要接受请求体中的租户或所有者字段作为授权依据。
3. **实现领域规则。** 状态机声明用于类型和编译反馈；执行时仍以数据库中的
   权威状态检查版本及转换。使用条件更新或适当锁，避免先读再写的竞争窗口。
4. **接入一次治理。** 通过已有持久化命令执行授权、去重、业务写入和审计。
   handlers 使用提供的事务。已绑定 Command 的路由不要再次包装同一个 executor。
5. **接入入口。** HTTP 校验协议和取得可信身份，Worker 校验持久任务信封与恢复
   权限；两者进入同一受治理的业务操作。不要直接调用裸 `@Command.execute()`。
6. **生成、审查和验证。** 按下文执行局部校验；数据库结构变更生成候选，审查
   后加入正向迁移。提交说明分别记录实现、本地验证及实际交付状态。

例如“审批订单”的最小验收应包括：无权限时拒绝、版本过期不覆盖新数据、同一
操作键和相同输入只产生一次业务变化、相同键不同输入冲突、审计写入失败时业务
和 receipt 一起回滚。已有成功回执的再次读取也必须验证当前权限。

远端通知、支付等使用 `createExternalCommand` 的持久 intent / reconcile 流程。
不能用数据库回滚或 Effect 重试推断远端没有执行。

## 三份执行契约

**编译契约。** 保持严格编译默认值、持久化适配器要求以及模型应用的
`databaseGovernance: { mode: "check" }`。`commandCapabilities` 声明的是实际
已绑定端口的能力，不是通过填写 `true` 获得持久化。普通编译不连接数据库；
live Catalog `enforce` 使用明确选择环境的只读连接。

**业务执行契约。** 裸 Command 类、编译绑定的 Command 和
`createTransactionalCommand` / `createTypeBoxTransactionalCommand` 返回的持久化 facade 不可混用。遵循
[执行管线](../packages/app/EXECUTION.md)的入口：已绑定路由、
`executeCompiledCommand` 或受支持的 durable facade。`SC4029` 检查类型可见的
绕过调用；它不证明任意动态 JavaScript 都无法绕过边界。

**Effect 契约。** 路由声明依赖、对应的 tagged errors、必要的 timeout，默认
`retry: "none"`。生产代码不自行 `Effect.run*`。纯规则无需包装成 Effect；
已有异步 Command 也不因接入路由而获得第二套事务。详细约束见
[Effect governance](effect-governance.md)。

## 生成和迁移

模型应用首次初始化或模型变更后，在该应用目录执行：

```sh
bun run db:generate
bun run db:check
```

两个脚本分别执行模型/源契约的生成与只读一致性校验。一起提交 ZModel、
`zenstack/generated/`、`db/contracts/` 和相关源文件。

结构变更时，显式设置 `SUPACLOUD_MODEL_DATABASE_URL` 指向本地或影子数据库：

```sh
bun run db:diff -- --candidate output/database-audit/change.sql
```

审查候选中的删表、默认值、约束、映射和不支持的 PostgreSQL 对象，再将必要
变更加入新的迁移。应用使用现有 `supacloud db plan` / `db apply` 流程。
`db:pull` 仅用于存量结构核对，输出新的 `.zmodel` 候选，不能代替日常模型维护，
也无法推导业务权限。不要恢复 `dev migrate`、Drizzle 命令或运行另一套 migrate/db push。

## 验证按改动选择

日常只运行一个直接相关测试文件与 `git diff --check`。按变更需要补充局部类型、
生成物和编译检查；不要把 starter 聚合 `check` 或全仓测试作为每次小改动的默认。
文档修改验证链接和描述与源码一致即可。

| 改动 | 参考的可执行证据 |
| --- | --- |
| 模型、策略、原生驱动、共享事务 | [zenstack-upgrade.test.ts](../packages/db/src/zenstack-upgrade.test.ts) |
| TypeBox 命令、receipt 重放与再次授权 | [typebox.test.ts](../packages/commands/src/typebox.test.ts) |
| 模块重导出、DI 修饰符、生命周期、typed aspect 编译绑定 | [framework-architecture.test.ts](../packages/compiler/src/framework-architecture.test.ts) |
| 切面顺序、单次 continuation、作用域销毁 | [static-di-aop.test.ts](../packages/compiler/src/static-di-aop.test.ts) |
| 编译入口防绕过、executionPlan | [execution-contract.test.ts](../packages/compiler/src/execution-contract.test.ts) |
| typed aspect、模型 HTTP/Worker 共用命令、审计回滚 | [app-model-command-starter.test.ts](../packages/cli/src/shared/tools/app-model-command-starter.test.ts) |
| 跨步骤业务组合和恢复 | [fulfillment 示例](../packages/elysia/src/examples/fulfillment.ts)及[说明](framework-composition.md) |

上表用于选择与当前修改直接相关的一项，不是要求顺次运行全部文件。
ZenStack 测试的真实数据库用例要求 `SUPACLOUD_STARTER_POSTGRES_BIN` 指向本机
PostgreSQL 工具目录；未设置时会跳过，必须在结果中说明。它覆盖模型/receipt/audit
原子性，不等同于完整 HTTP、PGMQ 或生产多租户验收。

现有 `--template command` 的审批、附件和恢复是可运行的业务参考，但其写入
仍含可信原生 SQL、RLS 和锁处理。参考其契约与治理组织；新增模型写入按
`createZenStackDatabase(...).forIdentity(...)` 和 Command `transaction.db` 接入。
模型业务使用 `supacloud app init --root ./orders --name orders --template model-command`。
该模板提供创建/审批/读取订单、TypeBox、Effect 路由、编译命令切面、可信 host 和
Worker 处理器。HTTP/Worker 复用原操作键和当前权限解析；它不另建队列消费循环。
先生成模型与源契约，再编译；按生成的 README 应用正向迁移、配置独立数据库角色
和真实 IdentityAuthority。原生 SQL 的复杂 `command` 模板继续保留。

## 评审与后续框架演进

评审只回答本次变更涉及的问题：权限放在何处、哪一个事务负责提交、幂等键能否
跨入口保持、失败能否被真实证明、迁移是否追加、生成物是否来自本次源文件。
编译通过、数据库行为通过、npm 发布、合并和部署分别报告。

新业务切面优先使用 `defineOperationAspect`，显式提供输入、结果校验器与最小
capability 选择器。Command 切面成功返回必须来自一次 next，结果保持原值，不能
吞掉下游失败。只读类型与运行时冻结同时生效；拒绝业务操作时抛出契约错误。
具体能力和限制见静态 AOP 设计。后续演进应围绕真实业务缺口增加局部门禁，
不引入第二套容器、反射拦截或事务执行系统。
