# Command 迁移能力验收记录

日期：2026-09-09。范围为基于 main `18f84be7` 的本地 SupaCloud 隔离工作区，
不包含原共享工作区其他任务的改动，也不是客户项目或生产验收。
对应方案：[架构、迁移与恢复](./command-migration.md)。

## 包级结果

运行 `bun run verify:commands`，使用显式配置的独立本地 PostgreSQL 18.4 数据库。

| 包 | 源码类型检查 | 测试类型检查 | 测试通过 | 构建 |
| --- | --- | --- | --- | --- |
| contracts | 通过 | 通过 | 36 | 通过 |
| commands | 通过 | 通过 | 11 | 通过 |
| db | 通过 | 通过 | 101 | 通过 |
| app | 通过 | 通过 | 178 | 通过 |
| app-svelte | 通过 | 通过，Svelte 0 错误/0 警告 | 1 | 通过 |
| elysia | 通过 | 通过 | 102 | 通过 |
| compiler | 通过 | 通过 | 281 | 通过 |

本轮架构调整后重新完整运行，包级合计 710 项；发布准备及工作流相关测试另有
21 项通过，总计 731 项。这些是本次隔离提交范围的测试计数。
本次没有跳过原生数据库测试。额外通过 `scripts/tsconfig.commands.json` 工具脚本类型检查、
18 个包的工作区依赖边界检查和 `git diff --check`。

完整包级日志由验收入口生成在本地 `output/command-migration/01.log` 至 `39.log`，
属于可再生成产物，不作为客户生产回执。

## 实际边界

原生 PostgreSQL 覆盖：

- 并发提交同一操作，业务和审计只提交一次。
- 同库审计失败或结果 schema 不通过时业务回滚。
- COMMIT 应答丢失后恢复原回执，不重复业务写入。
- 不同输入冲突、租户/操作人隔离、权限撤销后重新授权。
- 外部发送成功但审计失败，保留 confirmed/audit-pending。
- 外部发送中并发提交，只返回已持久化意图，不增加发送次数。
- 意图提交后、发送前崩溃，保留 pending/unknown，不危险重投。
- 按操作编号恢复原始输入及回执；补审计不重发业务。
- 完整 Webhook HTTP 模块的身份、额外字段拒绝、幂等键、GET 回执恢复及审计回滚。
- 并发租约互斥、过期重新领取、旧 leaseId 不能释放新租约、退避与租户范围。
- 后台独立授权可恢复交互权限已撤销的操作，且不重新发送。
- 已完成输入清理后保留去重/冲突检测；未完成输入不清理；按编号恢复明确返回过期。
- 宿主提供 AES-GCM 输入 codec 的保存、解密恢复及篡改拒绝。
- v1 旧表升级保留原操作号、规范化输入、指纹及约束，升级可重复执行。

真实 Module/Controller/Command 源码经编译后生成静态工厂和 invoker，再通过 HTTP 访问
PostgreSQL；测试验证生成物无漂移，不依赖手写 CompiledModule 或抛错占位方法。
修复了此链路暴露的具名 Header 生成错误；无回执时使用 `{ receipt: null }`，
避免 null 被框架输出为空响应。已有 Job 执行入口也验收了恢复处理器接入。

真实 Chromium 浏览器加载当前构建后，Svelte 组件卸载、请求取消、迟到状态阻断、
持久锁恢复、迟到解锁阻断、当前操作解锁、互斥获取，以及组件复用时目标切换、
导航失效和导航订阅清理，十项均报告成功。
截图保存在本地 `output/playwright/supacloud-command-architecture.png`。
这里只验收真实 Svelte 组件和宿主导航钩子契约，没有运行完整 SvelteKit 路由或客户认证链。

## 类型与交付边界

新 contracts、commands 和 app-svelte 包启用了全部要求的严格选项，包括
`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、
`noPropertyAccessFromIndexSignature`、`noFallthroughCasesInSwitch` 和
`skipLibCheck: false`。

既有包检查沿用 main 上各自的配置；历史配置仍有 `skipLibCheck: true`，且并非所有既有源码
都已迁移到另外两个更严格选项。没有为了本次通过而关闭原有诊断；本记录不声称整个仓库
或所有第三方声明满足新包同等的最严格配置。新增边界代码未使用 any、双重断言或诊断抑制。

三个新包的 npm 本地打包清单检查通过。发布准备脚本的本地依赖转换和发布顺序经过测试，
但尚未执行 npm 发布、发布后安装、远程 CI 或客户认证提供方的线上验收。

客户仍需要实施应用私有 schema/权限迁移、身份接入、领域匹配、监控告警、回执保留策略
与恢复决策，并通过现有调度器实际启用恢复 Job。本地提供和测试处理器不代表生产任务
已经部署。外部操作没有跨服务原子性保证；维护成本下降仍需要客户同等功能模块的
前后对照，不以本地测试数量或代码行数替代该结论。
