# SupaCloud 命令安全架构与迁移方案

日期：2026-09-09。本文描述 SupaCloud 仓库内的实现和验收，不代表 npm
已经发布、客户已经迁移或生产环境已经验证。允许协议升级，不以维持旧行为为目标。
本地检查范围与结果见[当前验收记录](./command-workflow-verification.md)。

## 目标与边界

客户需要的是安全完成业务操作、在响应丢失后恢复结果，以及离开页面后不破坏后续操作。
Module、Controller、Command 只是组织方式，不提供跨远程服务的原子性。

| 所属包 | 承担职责 | 不承担职责 |
| --- | --- | --- |
| `@supacloud/contracts` | 根入口仅协议、回执、错误码与存储端口类型 | DI、认证服务、数据库、页面 |
| `@supacloud/contracts/client` 与 `/browser` | 可选客户端发送/作用域；可选浏览器锁协调器 | 领域锁策略、自动清锁 |
| `@supacloud/commands` | 不依赖 SQL/HTTP/Svelte 的事务执行、外部对账、单次恢复处理 | 消息领取、调度/退避队列、跨服务原子性 |
| `@supacloud/js` / 现有 Workflow、PGMQ | 统一命令状态查询、步骤投递、领取、重试预算、失败处理 | 将入队或 Workflow 完成视为业务已确认 |
| `@supacloud/app-svelte` | 将通用作用域接入卸载、目标变化、宿主导航钩子 | 自动解锁、替换 SvelteKit 或认证体系 |
| `@supacloud/db` | 同连接事务、执行回执、原提交身份绑定、事务内入队、输入清理 | 第二套恢复领取队列、远程发送 |
| `@supacloud/elysia` | 真实 Controller 调用、协议错误映射、可选持久化 RPC 适配器 | 依赖 DB 错误类、第二次执行或审计 |
| `@supacloud/compiler` | 检查命令策略与已声明执行边界 | 凭声明证明远程适配器真实可靠 |

普通查询和 CRUD 可以继续使用现有客户端或 PostgREST。只把需要业务语义的写入迁移到
Command，不强迫整个应用换框架。旧 app 路径目前只做重导出，没有两份实现。

## 替换表

| 旧做法 | 新入口/迁移动作 |
| --- | --- |
| 前端为契约安装完整 `@supacloud/app` | 客户端从 `@supacloud/contracts/client` 导入，浏览器锁从 `/browser` 导入 |
| 一个解码器同时验证写响应和查询结果 | `createAuthoritativeCommandClient` 分离三种解码器，默认查权威结果 |
| 401 后刷新并重发写请求 | `createAuthenticatedFetch` 在发送前取得令牌，之后不重发 |
| 所有请求共用 retry 拦截器 | 写入默认一次发送；只有明确具备服务端幂等协议才允许显式 opt-in |
| 同库更新后再独立请求审计 | `createTransactionalCommand` 在同一个数据库连接事务中完成三者 |
| 远程写入后审计失败就返回业务失败 | `createExternalCommand` 先保存意图；确认业务与补审计分开 |
| 页面 `finally` 或卸载时清锁 | 只在确认结果后，通过操作所有权和 `attempt.isCurrent` 清锁 |
| 刷新后重建原始表单来查结果 | `lookupByReference(identity, operationId)` 从持久记录恢复并重新授权 |
| 泛化的 `transaction: true` 能力声明 | 命名 adapter 声明 `database` 或 `external`，启用持久化编译检查 |
| 从 `@supacloud/db` 导入命令执行器和错误类 | 执行器从 `@supacloud/commands` 导入；`CommandError` 从 contracts 根入口导入 |
| 执行器接收 `database` | 改为 `store: createPostgresCommandStore(database)`，或自有端口实现 |
| 授权成功无返回值、异常代表拒绝 | 必须显式返回 `"allow"` / `"deny"`；异常或非法返回值是不可用，不是拒绝 |
| 默认明文保存输入 | 必须提供 `inputCodec`；非敏感输入显式选择 `plaintextCommandInput`，敏感输入由宿主加密 |
| 仅依赖卸载，组件复用时旧操作仍有效 | 传入含租户/用户/资源标识的响应式 `target`，并绑定宿主导航钩子 |

行为变化需要在应用发布说明中明确：写请求不再自动重试；部分错误返回 unknown；
外部操作可能 confirmed 但 audit=pending；持久锁不会因卸载、超时或刷新自动消失。

## 同库事务

1. 先安装平台现有 PGMQ、`workflows-public`、新版 `commands-public` SQL 模块，
   再通过应用迁移安装 `COMMAND_PERSISTENCE_SQL`。不要在 HTTP 请求中建表。
2. 使用 `createBunCommandDatabase(sql)`，从 `@supacloud/db/bun` 导入。
3. 用 `createPostgresCommandStore(database)` 提供存储端口，再调用 commands 包的执行器。
   业务更新、授权查询、领域审计必须使用执行器传入的 `tx`，不能独立请求远程审计服务。
4. 运行顺序为：幂等锁、当前权限检查、查回执、业务写入、结果校验、回执、审计、提交。

```ts
import { SQL } from "bun";
import { COMMAND_PERSISTENCE_SQL } from "@supacloud/db";

// DATABASE_URL 必须是应用迁移角色的连接，而不是浏览器凭据。
const connection = process.env["DATABASE_URL"];
if (!connection) throw new Error("DATABASE_URL required");
const sql = new SQL(connection);
try {
  await sql.begin(async (tx) => { await tx.unsafe(COMMAND_PERSISTENCE_SQL); });
} finally {
  await sql.close();
}
```

回执主键是 `(tenantId, actorId, command, operationId)`。相同键和相同规范化输入返回
原回执；同键不同输入报 `COMMAND_IDEMPOTENCY_CONFLICT`。每次重放和恢复都会重新检查
权限。授权回调的 `"deny"` 对应 `COMMAND_REJECTED` / HTTP 403；回调抛错对应
`COMMAND_UNAVAILABLE` / HTTP 503。租户与操作人必须来自服务端已验证上下文，
不能来自 body 或未经验证的代理头。

业务结果与审计详情必须能表达为 JSON。持久化输入解码器必须稳定：规范化后的 JSON
再次解码不能改变含义；不稳定的转换在发送前拒绝。升级输入或结果语义时使用新命令名，
例如 `webhook.update.v2`，保留 v1 解码器直到旧回执的保留期结束。

审计失败导致同库业务和回执一起回滚。连接中断或 COMMIT 应答丢失统一保守报告
`COMMAND_OUTCOME_UNKNOWN`，随后查回执；客户端不要把 503 当成可以生成新操作号的理由。
同键显式重试可由服务端去重，但客户端底层不会自动重发。

## 外部副作用

`createExternalCommand` 的顺序是：

```text
同事务提交 pending 意图与 Workflow 恢复步骤 -> 单次 send -> 只读 lookup 与领域 matches
  -> 提交 confirmed 结果 -> 独立事务补审计
```

`send` 收到服务端生成的稳定 `dispatch.idempotencyKey`。下游支持幂等键时必须转发它，
不要直接转发可能跨租户重复的浏览器 operationId。下游发送器必须禁用认证重放和写重试。

| 状态 | 可推断的事实 | 恢复方式 |
| --- | --- | --- |
| pending / audit=pending | 意图已持久化，可能尚未发出或仍在进行 | 查回执或只读对账，不重发 |
| unknown / audit=pending | 无法确认业务结果 | `reconcile` / `reconcileByReference` 或人工核实 |
| confirmed / audit=pending | 已匹配权威结果，但审计未完成 | `flushAudit` / `flushAuditByReference` |
| confirmed / audit=complete | 业务已确认且本地审计完成 | 可解除相应页面锁 |

`execute` 再次收到已有意图时只返回原记录，不自动重新发送。`lookupByReference` 只读本地
回执；`reconcileByReference` 可能访问远程只读查询并更新本地确认；补审计不调用 send。
交互式恢复重新校验用户权限；后台恢复使用独立 `authorizeRecovery`，不冒充已经撤销的
用户会话，回执仍保留原始 actorId。未提供后台授权回调时，恢复默认拒绝。

### Workflow 恢复

`createCommandRecoveryHandler` 提供 `run(claim)`，接收现有 Workflow dispatcher 已领取的
`reconcile` 步骤。传入 `workflows: supacloud.workflows`，按租户注册命令、服务身份、
独立授权和 `retryDelaySeconds`。它不自行 claim，不扫描回执表，也不创建定时器。

- 直接外部执行使用 `supacloud.command.reconcile`；原提交命令继续原 `command.<name>` Workflow。
- 任务只包含操作引用，不复制加密输入；初始恢复预算为 20 次，耗尽由现有 Workflow 死信处理。
- `run` 返回 `completed`、`retry` 或 `failed`；只有业务 confirmed 且审计 complete 才完成步骤。
- 领取、可见性超时、重试计数和旧 attempt 拒绝全部复用 Workflow/PGMQ。
- 传输或确认响应丢失时保留重投能力，但重投只运行对账和补审计，永不调用 send。
- 宿主 dispatcher 必须识别其他 Workflow，不能把不认识的任务当作恢复任务丢弃或确认。
- 继续在下游只读传输层设置超时，并监控 Workflow 失败/死信及回执 unknown 年龄。
- 输入清理独立调用 `store.redactCompleted`，由现有维护任务调度；不再捆绑进恢复循环。
  已完成输入清理后，后台仍可读取已确认回执以完成迟到的 Workflow 确认。

完整身份绑定、SDK 返回值升级、部署顺序见 [Workflow 收敛方案](./command-workflow-convergence.md)。

不能隐瞒的窗口：进程可能在意图提交后、实际 send 前崩溃。这时不会丢失意图，但也不会
保证自动完成业务。查询不到结果不等于未发生；无可靠下游回执时保持 unknown，人工决策。
当前没有宣称 exactly-once 分布式执行，也没有提供无条件自动重投的 outbox worker。

`matches` 必须验证目标、期望状态/版本及可获得的操作标识。仅仅读到当前 enabled=true
只能确认期望状态，不能证明“这次请求”造成了变化。涉及扣款、发送消息等非状态设置操作，
必须查询下游操作级回执；不能以当前资源状态替代操作因果证据。

## 数据库运维约束

- `supacloud_commands` 是私有服务端 schema，安装时撤销 PUBLIC 权限。不要暴露给
  PostgREST、浏览器角色或匿名角色；业务运行角色需要显式 schema/table 权限。
- 新表用 SHA-256 `input_fingerprint` 判断同键冲突，`input_payload` 通过必填 codec 保存。
  指纹不是加密，低熵内容仍可能被猜测；不要把令牌、密钥或非必要个人数据传入命令。
  codec、密钥轮换、结果/审计详情及备份的保护由宿主负责，输入加密不等于整张表加密。
- 该表没有自动 RLS；隔离依赖受信任宿主的身份与授权回调及固定 SQL 条件。运行角色不是
  浏览器身份。授权回调必须在事务里验证业务归属/权限，不可只检查 actorId 非空。
- 部署时由迁移角色建表，运行时授予 schema USAGE、回执 SELECT/INSERT/UPDATE、审计
  SELECT/INSERT，以及业务表所需权限。框架运行角色不需要 DROP/TRUNCATE/DELETE 权限。
- 不自动删除回执；删除会丢失去重能力。保留期必须覆盖客户端、任务队列和下游可能的
  重复窗口，pending/unknown/audit-pending 不可按普通缓存过期删除。
- 提供业务自己的告警：pending/unknown 年龄、待补审计数、冲突数、权限拒绝数。
  不把包含输入或数据库错误的原始异常返回客户端。
- 自定义数据库 adapter 必须保证 BEGIN 至 COMMIT 固定同一连接；不能用三个独立远程
  SQL 请求实现 `transaction()`。原生验收使用真实 PostgreSQL 和 Bun SQL 连接池。

### 旧原型表升级

没有旧表时仅安装 `COMMAND_PERSISTENCE_SQL`。使用过未发布 v1 原型的应用应先停止旧写入
和旧恢复进程，在迁移事务内执行 `COMMAND_PERSISTENCE_UPGRADE_SQL`，再启动新版。
它将原 `input_key` 转为 `input_payload`，计算指纹，为未完成操作补入 Workflow，
删除旧恢复租约/退避字段，不删除 operationId、dispatchKey 或业务回执。
不能把 `CREATE TABLE IF NOT EXISTS` 当作表升级；旧二进制不兼容新列。

迁移后的旧 payload 仍是明文。首次切换可以显式使用 `plaintextCommandInput` 读取这些
非敏感数据；需要加密时由宿主完成带版本 codec 和离线数据回填后再切换，不能直接用
新密钥尝试解密旧明文。迁移测试验证原始操作号、输入、指纹约束及重复执行。

清理输入后，交互式按编号恢复会返回 `COMMAND_INPUT_EXPIRED` / HTTP 410；提供原输入的授权
重放仍能返回同一回执，同键不同输入仍报冲突。前端不要因 410 删除锁或生成新操作号。
需要长期按编号查阅时，应调整保留期或提供领域自己的只读归档入口。

## Svelte 与认证接入

保留当前 Svelte、路由和认证提供方，仅替换命令发送入口。

```ts
import { createAuthenticatedFetch } from "@supacloud/contracts/client";

const send = createAuthenticatedFetch({
  getAccessToken: async () => sessionProvider.getCurrentAccessToken(),
  // 不传会重试的认证 SDK fetch；默认使用原生 fetch。
});
```

`sessionProvider` 是应用既有认证适配器；它可以在发送前刷新令牌，不得在发送后偷偷重发。
应用固定可信 HTTPS origin，浏览器 credentials 策略由请求本身显式指定。
`createSvelteCommandScope()` 在组件初始化阶段调用；localStorage/Web Locks 在浏览器阶段
初始化。为每次尝试生成并持久化 operationId，取得锁后才发送。

```ts
import { beforeNavigate } from "$app/navigation";
import { page } from "$app/state";
import { toStore } from "svelte/store";
import { createSvelteCommandScope } from "@supacloud/app-svelte";

// 组件初始化期间调用。verifiedTenantId/verifiedActorId 来自既有认证状态。
const scope = createSvelteCommandScope({
  target: toStore(() => JSON.stringify([verifiedTenantId, verifiedActorId, page.params.id])),
  onNavigate: (invalidate) => beforeNavigate(() => invalidate()),
});
```

不使用 SvelteKit 时可传自己的 Readable 和路由钩子。目标变化与导航只让旧 attempt 失效，
不销毁可复用作用域；卸载才 destroy。没有响应式 target 时，业务调用方仍必须显式
`scope.invalidate()`。导航被取消也会保守失效，调用方重新读取回执，而不是重新发送写入。

锁的 namespace 应含应用、tenantId、actorId 和命令版本，target 表示业务对象。新页面读到
锁后按 operationId 查回执，不创建新写请求。迟到回调只有当前 attempt 才能更新状态或
清除对应锁。跨组件的共享协调器必须遵守相同命名协议；本地锁不是抵抗恶意客户端的措施。

没有 Web Locks、存储被禁用或 JSON 损坏时显式报错并暂停写入，不降级成不受保护的
localStorage 操作。不要在 `finally` 中清锁，也不要以 401、404 或请求取消代替业务确认。

## 编译器与服务端

```ts
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  requireRouteContracts: true,
  commandCapabilities: {
    requirePersistentAdapters: true,
    permission: true,
    rpc: {
      webhookUpdate: {
        boundary: "database", transaction: true, audit: true, idempotency: true,
      },
      externalSsoUpdate: {
        boundary: "external", transaction: false, audit: true, idempotency: true,
      },
    },
  },
});
```

命令声明必须包含 permission、audit、required idempotency。同库命令声明
`transaction: "required"`，外部命令声明 `"none"`。通过
`createPersistentCommandAdapter` 可以注册命名执行器。更直接的模块接入方式是让真实
Controller 调用注入的 Command 实例；路由不绑定第二个 `command:`，编译配置
`allowRouteCommandBindings: false`，避免绕过 Controller。示例采用后一种方式，
授权/幂等/审计由 Command 内的执行器保证，装饰器仅组织模块并声明待验证的能力。
Command/Route 的 aspects 应仅做其明确声明的职责，不能暗中重试业务副作用。

错误代码 `command-persistence-required`、`command-external-transaction` 提供人工可读建议，
通过现有 JSON 诊断输出。编译失败不覆盖上次生成物。配置只是待验证的能力声明，不会自动
安装数据库表或证明自定义适配器满足承诺。服务端 `normalize: false` 可拒绝多余字段，
避免底层静默删除字段后使校验看似成功。

## 完整模块与验证

仓库提供可运行的 Webhook Module/Controller/Command 示例：

- `packages/elysia/src/fixtures/webhook/`：真实装饰器 Module/Controller/Command、共享 schema、
  请求作用域身份、原生事务更新和审计、GET 操作编号恢复入口。
- `packages/elysia/src/fixtures/webhook-generated/`：由 `bun run generate:example` 生成，
  纳入源码类型检查；测试验证生成物与源码一致。不要手写或修改生成物。
- `packages/elysia/src/webhook-migration-example.ts`：仅宿主装配，导入实际生成的工厂。
- `packages/elysia/src/webhook-migration.test.ts`：HTTP 到原生 PostgreSQL 的整模块验收。
- `packages/compiler/src/command-persistence.test.ts`：真实装饰器源码编译，验证绑定和失败保护。
- `packages/elysia/src/command-postgres.test.ts`：运行时与 DB 的联合原生验收，包含租约、
  后台独立授权、输入加密/清理、v1 升级及原有故障用例。
- `packages/app-svelte/src/BrowserHarness.svelte`：真实组件卸载、复用/目标变化、导航钩子和持久锁验收。

```gherkin
Scenario: 同库审计失败
  Given Webhook 更新与审计使用同一事务连接
  When 审计失败
  Then 业务写入和回执都不提交

Scenario: 远程成功但审计失败
  Given 权威查询确认目标业务结果
  When 本地审计暂不可用
  Then 回执为 confirmed 且 audit 为 pending
  And 补审计不重新发送业务写请求

Scenario: 页面卸载后的迟到响应
  Given 新页面已恢复旧操作的持久锁
  When 旧页面的请求完成
  Then 它既不能更新页面状态也不能解除持久锁
```

使用独立本地数据库 `supacloud_commands_test`，设置 `SUPACLOUD_COMMAND_TEST_URL` 后运行
`bun run verify:commands`。该入口强制要求原生数据库，不允许把跳过测试当作完整验收；
依次刷新本地依赖、检查七个包的源码和测试类型、运行测试、构建并检查包边界/发布脚本。
浏览器验收单独运行 `packages/app-svelte` 的 `bun run test:browser` 并检查 `#result`。

目前新的 contracts/commands/app-svelte 包启用全部要求的严格选项，包括 `skipLibCheck: false`。
既有包沿用 main 上各自的配置，仍有 `skipLibCheck: true` 等历史差异；局部检查通过不代表
整个并发修改中的仓库满足全部最严格选项，也不代表客户真实认证环境已验收。

## 发布与切换顺序

1. 先完成本地门禁和代码审查；发布 contracts，再 commands/db，再 app/compiler/app-svelte，
   最后 elysia。发布流程会把本地 `file:` 和 overrides 转成精确版本，不把构建示例所需的
   devDependencies 升为运行时依赖。命令协议的不兼容变化应发布相应的破坏性版本说明，
   不能覆盖已有 npm 版本；本文中的工作区版本号不代表新架构已在同号 npm 版本中发布。
   依赖尚未在 npm 可见时停止，不继续发布损坏的依赖包。
2. 运维安装私有 schema 与角色权限；部署新 Command 和回执查询入口，旧读取链可保留。
3. 前端切换单次发送、持久 operationId 和生命周期保护。灰度期间同一写操作只能有一个
   主执行入口，不允许旧写接口与新接口双写做“对照”。
4. 注入实际认证刷新、断网、页面切换和审计中断故障；收集业务与下游回执，不只看 HTTP 200。
5. 对账所有待处理回执后退役旧入口。记录新包版本、命令版本、迁移版本与恢复负责人。

回滚不是删表：停止新写入口，保留回执与恢复入口，处理已产生的 pending/unknown 和
待补审计记录。需要切回旧实现时，旧入口也必须遵守既有 operationId 去重，或暂时只读；
不能因为软件版本回滚而使已执行操作重新执行。

## 维护成本的证据口径

本次把认证重放、事务回执、外部对账和生命周期所有权变成 SupaCloud 的公共能力，
提供的是可复现故障语义与模块验收，不以“新增代码少”作为结论。
客户仍拥有领域 schema、权限规则、权威匹配、分页完整性和恢复决策。

后续客户试迁移需要对同一个完整模块、同等故障验收做前后对照，分别统计业务代码、
接入代码、测试代码、依赖体积和新需求变更涉及文件数；不能把原本没有的安全机制排除成本，
也不能用本示例规模替代客户真实维护成本。本次没有宣称整体迁移已被证明更省维护。
