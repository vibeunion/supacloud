# Preview Environment：待决问题报告

状态：**待产品/架构决策**（截至 P1-5 Preview 组合、供给编排、隔离验收、生命周期与
database/queues/storage 端口均已完成并提交 PR）。

本报告把「继续实现 Preview 供给」所缺少的、必须由产品或基础设施拍板的接口与约定集中
列出。每条给出：**问题**、**候选方案**、**建议**、**阻塞影响**、**关闭条件**。这些点若
用占位实现，会造成「声称 ready / reclaimed 但实际未供给或未隔离」的错误结论，因此当前
一律**失败关闭**（缺失端口即报错），不猜测。

## 0. 背景与已完成部分

Preview 定义为完整环境，已实现并提交：

| 层 | PR | 说明 |
| --- | --- | --- |
| 组合定义 | #1528 | database / application / configuration / resources / queues / storage / secrets 七组件；四项隔离检查；`pr_closed`/`timeout` 回收策略与残渣策略；生产阻断 |
| 供给编排 | #1529 | 端口驱动、按依赖顺序、首个失败即停、隔离只在组件全 ready 后执行 |
| 生命周期持久化 | #1530 | `PreviewStore`、`created_at`、超时回收、仅全成功才移除记录 |
| 隔离证据验收 | #1531 | `evaluatePreviewIsolation`：无证据即 `pending`，全通过才 `accepted` |
| 生命周期路由 | #1532 | list / close / reclaim；未配置清理端口返回 `501` |
| 具体端口 | #1533 | database→分支服务、queues→pgmq、storage→存储驱动；结构化 `queue_names` / `storage_buckets` |

未完成、阻塞于决策的端口：**application、configuration、resources、secrets**，以及
**隔离证据采集器**。

## 1. application 端口：Preview 激活身份与配置修订

**问题**：把应用 release 激活到 Preview 环境时，`activation_id` 与 `configuration_id`
从哪里来？现有 `ApplicationDeploymentService.activateConfigured` 要求不可变的配置修订和
明确的激活身份，否则无法幂等与审计。

**候选方案**：
1. `activation_id` 由 `preview_ref` 确定性派生（如 UUIDv5(namespace=project, name=preview_ref)），
   `configuration_id` 由发布契约或环境默认配置生成。
2. 每次 Preview 更新产生新的 `activation_id`，由 CI 显式传入。
3. Preview 不激活实际进程，只做静态绑定（则 application 组件不进入 `ready`）。

**建议**：方案 1。确定性激活身份便于重试与审计，且与「一个 PR 一个 Preview」对齐。

**阻塞影响**：无法实现 application 端口与真实「可运行」。

**关闭条件**：明确 `activation_id` 派生算法、`configuration_id` 来源，并授权写入
`ApplicationActiveStorage`。

## 2. configuration 端口：配置内容来源与修订

**问题**：Preview 环境的配置（`ApplicationConfigurations.put`）内容来自哪里？是否包含
非敏感默认值、测试密钥引用、以及从发布契约派生的变量？

**候选方案**：
1. 仅来自发布契约 + 环境默认值，Secret 只按名引用。
2. 由 CI 显式上传一份 Preview 配置。
3. 复制父项目配置并覆盖差异（需明确哪些键可复制）。

**建议**：方案 1，禁止复制父项目生产配置，避免隐式泄漏。

**阻塞影响**：无法生成 `configuration_id`，application 端口与配置隔离检查无法验证。

**关闭条件**：明确配置字段白名单、Secret 引用语法、修订生成规则。

## 3. resources 端口：绑定来源与隔离

**问题**：Preview 的资源绑定（database/bucket/queue/config/secret）从哪里解析？是复用
编译器的 `EnvironmentBinding` 投影，还是由平台按 Preview 命名空间自动派生？

**候选方案**：
1. 复用编译器 `supacloud.environment-bindings.v1`，要求存在 Preview 环境条目。
2. 平台按 `preview_ref` 自动派生 `project:preview-<ref>-*` / `bucket:...` / `secret:...`。
3. 混合：显式绑定优先，缺失则按命名空间派生。

**建议**：方案 3，但派生项必须落入四项隔离检查，不能仅靠前缀。

**阻塞影响**：resources 组件无法 ready；存储权限隔离检查无依据。

**关闭条件**：确定绑定来源优先级、派生命名规则、与 `EnvironmentBinding` 的关系。

## 4. secrets 端口：测试凭据来源

**问题**：Preview 的外部服务凭据（支付、邮件等）默认禁止真实副作用，测试凭据从哪里取？

**候选方案**：
1. 平台内置 sandbox 凭据（按供应商），仅引用不落盘。
2. 由项目级测试凭据库提供，按 `secret:<name>` 引用。
3. 无 sandbox 的服务默认禁用该组件（显式声明）。

**建议**：方案 1+3，无 sandbox 的能力显式禁用，不静默降级到真实凭据。

**阻塞影响**：secrets 组件无法 ready；「默认禁止生产副作用」无法落实。

**关闭条件**：列出支持 sandbox 的供应商、凭据注入方式与禁用清单。

## 5. 隔离证据采集器：观测来源

**问题**：`evaluatePreviewIsolation` 需要以下观测，由谁提供、如何采集？

| 检查 | 需要的观测 |
| --- | --- |
| `database_role` | Preview 数据库角色的实际权限（是否含 cluster 管理权） |
| `storage_permissions` | 存储绑定的实际访问范围（是否仅限 Preview） |
| `consumer_identity` | 队列消费者运行身份 |
| `route_access_control` | 路由是否拒绝生产凭据、是否可公开索引 |

**候选方案**：
1. 平台主动查询（DB 角色查询、存储策略查询、网关配置查询）——最可信，需逐项定义查询。
2. 由部署/CI 上报证据（当前 `POST /previews/acceptance` 的形式）——最灵活，可信度取决于调用方。
3. 混合：平台能查的主动查，其余上报。

**建议**：方案 3，且上报证据需绑定不可变标识（release/配置修订）防伪造。

**阻塞影响**：`accepted` 只能依赖调用方自报，隔离验收强度不足。

**关闭条件**：逐项确定采集来源、查询语句/接口、证据的不可变绑定方式。

## 6. 清理端口的后端选择与语义

**问题**：storage 端口当前适配「存储驱动」，但需确认：

- 使用哪个驱动（JuiceFS / S3 / 其它）以及如何按项目取得驱动实例；
- 删除桶时是否要求桶为空、是否允许强删；
- 队列删除是否连带清空消息（`pgmq.dropQueue` 语义）。

**建议**：删除前要求空桶/显式强制标志；队列删除默认连带清空并在回执中记录。

**阻塞影响**：生命周期路由的 reclaim 仍返回 `501`，无法真实拆除。

**关闭条件**：确定驱动获取方式与删除语义，并授权在 Preview 命名空间内执行。

## 7. Preview 与数据库分支的一致性

**问题**：Preview 分支默认 `schema_only`，但数据库迁移恢复路径与父项目回滚如何协调？
Preview 关闭时，迁移是否可能已被提升到父项目？

**建议**：Preview 关闭只删除分支与命名空间；迁移提升必须走既有
[数据库环境晋升](./database-environment-promotion.md) 流程并单独审计。

**阻塞影响**：回收策略的「残渣清理」范围与释放顺序。

**关闭条件**：确认 Preview 关闭不触碰父项目数据，迁移提升独立记录。

## 8. 授权与审批

**问题**：谁可以创建 Preview、批准 `full_clone`、以及触发 reclaim？

**建议**：创建沿用项目级鉴权；`full_clone` 需管理员显式授权并记录审计；reclaim 允许项目级
或管理员触发，且必须留回执。

**关闭条件**：确定角色矩阵与审计要求。

## 决策汇总（需要明确答复的最小集合）

1. `activation_id` 派生算法与 `configuration_id` 来源。
2. Preview 配置字段白名单与 Secret 引用语法。
3. 资源绑定来源优先级与派生命名规则。
4. 无 sandbox 的外部服务禁用清单。
5. 四项隔离检查的采集来源（平台查询 vs 上报）与证据绑定方式。
6. 存储驱动获取方式与删除语义（空桶/强删）、队列删除语义。
7. Preview 关闭与迁移提升的边界。
8. Preview 操作的角色矩阵与审计要求。

以上任一项确认后，即可对应实现一个端口/采集器并提交独立 PR；其余保持失败关闭。
## 已采纳决策（评审结论）

以下各项已在 `services/preview-*` 中以纯合约原语落地，不再阻塞后续端口实现：

1. **`activation_id` / `configuration_id`**：`activation_id` 由 UUIDv5 确定性派生
   （`UUIDv5(UUIDv5(NAMESPACE_URL, "supacloud:project:<id>"), "preview:<ref>")`）；
   `configuration_id = "cfg_" + base32lower(sha256(canonical_json(config)))`。
   `preview_ref` 仅接受 `pr-<num>` / `change-<id>`。
2. **配置字段白名单与 Secret 引用语法**：配置只允许发布合约 + Preview 默认值 + Secret
   引用；环境变量键必须在白名单内；Secret 引用语法为
   `secret://preview/<project>/<slug>/<name>`。禁止复制父项目生产配置。
3. **资源绑定来源与命名**：命名按 kind 派生（namespace/database/queue/bucket/secret/
   configuration），前缀不构成隔离证据，隔离仍需四项独立检查。
4. **无 sandbox 的外部服务**：仅 `stripe`/`paypal`/`sendgrid`/`sentry`/`oauth`/
   `webhook` 可启用；其余一律 `disabled`。
5. **隔离证据采集来源**：仍待产品确认（见下）。
6. **存储/队列删除语义**：强删非空桶需平台 ops；队列删除语义仍待确认。
7. **关闭与迁移提升边界**：迁移提升永远需要独立审批，不自动执行。
8. **角色矩阵**：成员仅能关闭自己的 Preview；`full_clone` 需管理员；强删非空桶需 ops；
   `use_real_credentials` 对所有角色拒绝。

### 仍需业务方答复

- sandbox 供应商最终清单与配额（当前清单为暂定）。
- Preview 默认超时与 `pr_closed` 后的宽限期。
- `full_clone` 的脱敏规则与最大数据量。
- 审计事件保留期限。
- 项目管理员是否可强删非空桶（当前：仅 ops）。
- Preview 是否可对外公开（当前：默认不公开）。
- 四项隔离检查的证据采集来源（平台查询 vs 运行时上报）。
