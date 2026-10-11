# 开发、预览与生产数据库迁移

SupaCloud 的推荐模型是“迁移文件逐级晋升”，不是把开发数据库整体复制到生产数据库。

## 环境分层

| 环境 | 数据 | 作用 | 推荐操作 |
| --- | --- | --- | --- |
| 本地 | 可重建的 seed 数据 | 编写和重放迁移 | `supacloud-cli supabase db_reset --no_seed` |
| Preview | 默认 schema-only，可选脱敏数据 | PR/分支验证 | 创建分支、应用迁移、跑 smoke test |
| Staging | 独立持久项目 | 发布前验证 | CI 自动执行 dry-run 和 migration push |
| Production | 真实数据 | 线上服务 | 备份、人工批准、单一串行发布任务 |

## 创建 Preview 分支

默认创建无业务数据的 schema-only 分支：

```bash
supacloud-cli branch create --name feature-orders --data_mode schema_only
```

只有在明确授权、数据已脱敏或不敏感时，才使用完整数据克隆：

```bash
supacloud-cli branch create --name debug-import --data_mode full_clone
```

schema-only 克隆仍会保留 `supabase_migrations.schema_migrations` 账本元数据，因此可以继续校验分支和父项目的迁移共同祖先；平台不会自动复制业务表行、Auth 用户或 Storage 对象。迁移 SQL 本身仍可修改父项目数据，必须像代码一样审阅。

## 安全提升迁移

先生成计划。CLI 默认只显示版本、名称、语句数量和 SHA-256，避免在终端日志里回显 SQL；Web Console 和受控 API 会提供 SQL 供逐条审阅：

```bash
supacloud-cli branch promotion_plan --branch_ref <preview-ref>
```

计划会在以下情况阻断：

- 父项目有分支尚未包含的迁移；
- 同一版本的 checksum 不一致；
- 迁移名称与父项目冲突；
- 迁移版本早于父项目最新版本；
- 迁移包含 `CREATE INDEX CONCURRENTLY`、`VACUUM` 等不能放在事务路径中的操作；
- 迁移包含 `DO` 过程块、角色/数据库管理、服务端文件或程序访问、外部数据库连接、事务控制、session role 或 advisory-lock 控制等越界 SQL；
- 迁移没有可执行 SQL。

审阅 checksum 后再提升：

```bash
supacloud-cli branch promote \
  --branch_ref <preview-ref> \
  --plan_checksum <sha256>
```

提升过程在控制数据库连接上同时锁住父项目和分支，并重新计算计划。迁移 SQL 使用父项目专属、无集群管理权限的数据库角色和独立连接执行，不能接触控制锁连接。计划发生漂移时会拒绝执行。只会把迁移账本中父项目缺失的 SQL 逐条应用到父项目；平台不会自动复制分支业务数据。

### CLI 回执与不确定结果

CLI 提交前重新查询平台计划，校验项目、分支、审阅 checksum 和破坏性确认。
计划已无待执行迁移时，返回 `unchanged=true`、`promoted=false` 和
`mutation_sent=false`，不发送提升 POST。计划漂移、阻断或响应不可验证时也不发送 POST。
这仅表示当前账本无需提升，不证明任何先前超时请求成功，也不证明应用已部署或通过线上验收。
实际执行仍由平台锁和计划校验防止查询之后的并发漂移；CLI 校验成功收据中的迁移集合
与提交前已审阅集合完全一致，不接受缺失或额外迁移的成功声明。

```gherkin
Scenario: 无变化的提升
  Given 平台返回匹配审阅 checksum 的安全计划且没有待执行迁移
  When 用户执行 branch promote
  Then CLI 返回 unchanged 且不发送 POST
  And 不把当前状态当成先前请求的成功收据

Scenario: 提交前发现漂移或阻断
  Given 平台计划已漂移、存在阻断或缺少破坏性确认
  When 用户执行 branch promote
  Then CLI 返回未发送 mutation 的错误且不执行迁移

Scenario: 提交前的证据不可验证
  Given 平台计划查询失败、响应损坏或项目分支身份不匹配
  When 用户执行 branch promote
  Then CLI 不发送 POST 且不报告提升结果不确定

Scenario: 成功收据必须对应本次审阅集合
  Given 提升 POST 已发送
  When 收据遗漏、改变或新增本次计划之外的迁移
  Then CLI 返回 OUTCOME_UNKNOWN 并保留原审阅 checksum
  And 不自动重放 POST
```

CI 可使用 `--json` 获取 `supacloud.cli.release-control.v1` 回执：

```bash
supacloud-cli branch promotion_plan --branch_ref <preview-ref> --json
supacloud-cli branch promote --branch_ref <preview-ref> --plan_checksum <sha256> --json
```

CLI 校验父项目和分支归属、SHA-256 格式、迁移版本唯一性、阻断项及破坏性确认标志。成功回执必须明确 `branch_data_copied=false`，回读计划必须没有待执行迁移或阻断项；本次应用的迁移必须在回读账本摘要中以相同 checksum 出现。`reviewed_plan_checksum` 是提交时审阅的计划摘要，`plan.plan_checksum` 是执行后的账本摘要，二者可能不同。

文本和 JSON 输出都不回显 SQL、远端错误原文或任意警告文本。阻断原因使用 CLI 内置说明；`reported_applied_versions` 只是服务端报告的部分应用线索，不代表 CLI 已独立验证提交结果。

提升 POST 超时、5xx、响应体损坏/超限或不完整的 2xx 回执均返回 `OUTCOME_UNKNOWN`，并保留父项目、分支、审阅 checksum 和重新获取 `promotion_plan` 的参数。提交前查询失败则返回 `mutation_sent=false`，不把尚未发送的提升操作标记为结果不确定。CLI 不自动重放 POST、不自动提升下一批迁移，也不自动反向执行 migration。收到明确 4xx 后仍须检查回执中的部分应用线索，不能假设之前的迁移全部回滚。

此版本的计划/回执响应体上限为 512 KiB，响应体读取超时为 5 秒；promotion POST 请求头等待预算为 30 秒。提升 POST 收据超限是未确认结果，不是迁移失败证明。重新获取计划会调用现有平台计划接口，可能幂等准备账本元数据和迁移角色，不应把它描述成数据库层面的纯只读查询。

验收场景：

```gherkin
Scenario: 查看已绑定环境的计划
  Given 计划属于请求的父项目和 Preview 分支
  When 用户执行 promotion_plan --json
  Then CLI 返回经过校验的摘要并省略 SQL

Scenario: 拒绝异域或矛盾计划
  Given 计划归属不同或迁移 checksum 与结构不合法
  When 用户查看计划
  Then CLI 返回错误且不宣告计划可用于提升

Scenario: 确认执行后的账本状态
  Given 平台返回已提升回执和收敛的回读计划
  When 已应用版本及 checksum 与回读摘要一致
  Then CLI 才宣告提升完成并明确未复制分支数据

Scenario: 请求结果无法确定
  Given POST 超时或返回损坏、不完整的响应
  When CLI 无法验证成功回执
  Then CLI 保留请求身份并返回 OUTCOME_UNKNOWN
  And CLI 不重复发送 POST 或反向迁移

Scenario: 只读模式
  Given CLI 处于只读模式
  When 用户执行 promote --json
  Then CLI 返回 READ_ONLY 错误且不发出写请求
```

## 破坏性迁移

包含删除列、删除表、删除策略/约束、关闭 RLS、截断或批量删除的迁移需要额外确认：

```bash
supacloud-cli branch promote \
  --branch_ref <preview-ref> \
  --plan_checksum <sha256> \
  --confirm_destructive true
```

生产发布前仍应执行：

1. schema/data backup 或 PITR；
2. Staging 完整重放和应用 smoke test；
3. 检查 RLS、函数、Trigger、Realtime 和 Edge Function；
4. 确认回滚或 forward-fix 方案；
5. 只允许一个 CI migration job 触碰生产库。

无法在事务中执行的 PostgreSQL 操作不要塞进普通迁移，应走单独的维护窗口/运维任务，并记录完成后的迁移账本状态。

## 整库替换（break-glass）

整库替换不是常规发布方式。它会停止父项目运行时、保留旧数据库备份，然后用分支数据库替换父数据库，可能丢失分支创建之后的生产写入。

该操作只对管理员开放，和普通迁移共用父项目/分支互斥锁，需要在 API 中明确指定 `mode=replace_database` 并输入精确确认文本：

```text
REPLACE <parent-ref> WITH <branch-ref>
```

正常 CI/CD 和 Web Console 流程都应使用 migration promotion。

API 成功时会返回旧父数据库的 `backup_database`。如果数据库已经切换、但 PostgREST/GoTrue 未恢复健康，API 返回 `replacement_runtime_unavailable`、`replacement_committed=true` 和备份名；此时不要重复提交 replacement。

切换阶段会在 control database 写入 `branch_replacement_journal`。Management API 启动时会在父项目/分支互斥锁下检查数据库实际名称，并幂等完成以下恢复：删除未提交的临时库、把中断在第一次 rename 后的旧父库恢复原名，或在第二次 rename 已完成时恢复新父库运行时。无法安全判定或健康检查仍失败时，API 保留 journal 并返回 `recovery_required=true` 与 `recovery_database`，禁止盲目重试。

管理员回滚步骤：

1. 保持维护窗口，停止父项目运行时并阻止新的 migration job；
2. 记录当前父数据库和 `backup_database` 名称；
3. 终止这两个数据库的活动连接；
4. 把当前父数据库改名为新的故障留档名，再把 `backup_database` 改回父数据库原名；
5. 对恢复后的父数据库执行 `ALTER DATABASE <parent-db> ALLOW_CONNECTIONS true`；
6. 清理连接缓存，重启运行时，确认 PostgREST/GoTrue 为 `running/healthy`；
7. 在确认窗口结束前保留故障库和原备份，不要自动删除。

break-glass 备份当前是相邻 PostgreSQL 数据库，不会自动进入 PITR/逻辑备份保留策略；保留期限和最终清理由管理员显式决定。
