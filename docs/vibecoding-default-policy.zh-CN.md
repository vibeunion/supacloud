# Vibecoding 默认策略

## 核心原则

默认值不是“功能最少的方案”，而是当前项目认为**最好用、最成熟、最容易验证和维护的方案**。

在没有特殊需求时：

1. 只提供一条推荐路径；
2. 生成器、文档和 AI 上下文都使用这条路径；
3. 其他方案必须显式选择，并说明适用场景；
4. 替代方案不能创建第二个权威来源或第二套治理语义。

目标是降低 Vibecoding 的架构熵，而不是限制所有高级能力。

## 默认决策

| 问题 | 默认方案 | 显式例外 |
| --- | --- | --- |
| 单次异步业务 | `Promise<T>` + `async/await` | 只有持续事件或生态适配才使用流类型 |
| 持续事件协议 | `AsyncIterable<TEvent>` | 已有 RxJS/Angular 事件组合使用 RxJS 适配器 |
| RxJS 选择 | 项目内唯一的响应式事件库 | 不再引入第二个 Observable/stream 库 |
| HTTP 字节流 | 原生 `Response` / `ReadableStream<Uint8Array>` | 需要生态适配时在边界转换 |
| 数据库结构 | Drizzle schema + append-only migration | 不建立第二套 ORM 或手工结构来源 |
| 数据库治理 | `defineDatabaseModule`、SQL lint、Catalog reconcile | 关闭治理只能是有记录的迁移例外 |
| 普通读取 | PostgREST / `supabase-js` | GraphQL 仅用于明确的 Query Contract |
| 跨表写入 | Command / RPC + 权限、事务、幂等、审计 | 单表简单写入可使用受控 CRUD |
| durable 执行 | Workflow/Command | pgflow、pg_durable 需要场景证明 |
| 新应用模板 | `minimal` | `command`、`http`、`edge` 显式选择 |
| 本地开发 | `fast`，不连接外部数据库 | `integration` 要求显式 loopback URL |
| 生成产物 | 编译器生成并检查漂移 | 不手改生成目录绕过检查 |
| 失败处理 | fail closed，保留上一次有效产物 | 不自动修复、迁移或静默降级 |
| 写操作重试 | 默认不自动重试 | 服务端具备幂等协议时显式启用 |
| 外部副作用 | receipt + reconcile | 未知结果不得自动 redispatch |
| AI 上下文 | 只读结构化 context pack | 不扫描凭据、真实数据或任意仓库 |

## 何时允许第二条路径

替代方案只有在以下条件全部满足时才进入项目：

- 默认方案无法表达真实需求；
- 替代方案的 owner、生命周期、取消、错误和重试语义明确；
- 有对应的类型、治理和负向测试；
- 不重复提交、不产生第二个权威来源；
- 能通过编译器诊断或显式配置被识别。

“团队有人熟悉”“API 看起来类似”“以后可能需要”都不是例外理由。

## 对 AI 的约束

AI 生成普通功能时，不应在多个等价框架之间提问或自由选择，而应直接使用默认路径。
只有检测到特殊需求时，才输出：

1. 默认路径无法满足的具体原因；
2. 选择的替代方案；
3. 新增的治理和测试责任；
4. 对生成目录、数据库来源和运行时 owner 的影响。

因此，“默认唯一”真正约束的是**决策入口**，不是能力上限。
