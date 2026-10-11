# 应用环境提升

状态：CLI 已支持只读计划、自动提升、状态观察、未知结果恢复观察和隔离 preview；
服务端负责持久化提升编排。生产部署与线上业务验收仍是独立状态。
计划既不是部署回执，也不是线上验收结果，不授权生产变更。

```bash
supacloud-cli --env production app promote-plan --id reviews \
  --environment_id production --source_ref staging \
  --source_environment_id staging --source_release_id <sha256>

supacloud-cli --env production app diff --id reviews \
  --environment_id production --source_ref staging \
  --source_environment_id staging --source_release_id <sha256>

supacloud-cli --env production app promote --id reviews \
  --environment_id production --source_ref staging \
  --source_environment_id staging --source_release_id <sha256> \
  --confirm-production production
```

`--id` 和 `--environment_id` 选择目标应用及环境；目标项目来自当前 profile，
或在执行策略允许时使用 `--ref`。源项目、环境和不可变版本分别由必填的
`--source_ref`、`--source_environment_id`、`--source_release_id` 指定。
作用域帮助同时列出源、目标和输出参数，不需要先配置 API 凭据。
`--json` 或 `--format json` 返回完整结构化计划，不能将 `--json` 与 `--format text` 混用。

平台验证源制品、当前激活、成功 mutation 回执、实时 readiness 和近期
authenticated smoke 证据；目标使用自己的不可变配置版本、迁移账本和 CAS。
只读计划不复制源密钥或配置值，不建立目标制品目录，不执行 SQL、不创建备份、不激活。
计划摘要只包含环境身份、下一步动作和阻断原因；`--format json` 保留完整计划。

## 账本与并发证据

成功回执必须通过现有激活账本解析器校验：规范的带类型资源键、项目和环境身份、
完整检查点、最终阶段、请求指纹及完整目标激活记录均须匹配。
裸哈希资源键、缺失或未完成的检查点、配置摘要或 host 漂移不能确认成功。
符合原有恢复指纹规则的成功 reconciliation 仍可作为证据，不引入第二套账本。

在观察前、回读前和返回前，分别检查源环境与目标环境是否存在未完成 mutation，
共六个检查点。任何一处发现忙碌或结果不确定的写操作，均返回
`APPLICATION_PROMOTION_BUSY`（HTTP 409），不能返回 promote 或 no-op。
账本查询异常会被净化，不返回提供方错误、配置值或内部检查点。
这些多次读取用于发现漂移，并不构成跨多个系统的原子快照。

迁移 pending 时计划阻断，并列出“先备份，再审阅并执行迁移”的前置步骤。
CLI 允许仅有 `MIGRATION_PENDING`/`BACKUP_REQUIRED` 的计划交给服务端受控编排；
冲突、缺失配置、未验证源或 operator provisioning 仍在提交前拒绝。破坏性 SQL
必须额外提供 `--approved_migration_digest <精确执行计划摘要>`，不自动生成审批。
`app promote` 会重新获取并验证计划；完整 no-op 不发送 POST。需要执行时由
SupaCloud 生成稳定的 mutation ID 并只提交一次提升请求。未知 HTTP 结果只返回
mutation ID，不自动重试、不自动降级、不自动恢复数据库：

```bash
supacloud-cli --env production app promote-status --id reviews \
  --environment_id production --mutation_id <uuid>
supacloud-cli --env production app promote-reconcile --id reviews \
  --environment_id production --mutation_id <uuid> --confirm-production production
```

SupaCloud 自动负责制品转移、稳定备份身份、备份 readback、锁内迁移、迁移账本
readback、CAS 激活、authenticated smoke、证据和最终回执。CLI 只负责选择环境、
生产确认、提交一次请求和展示可观察状态；业务验收、数据库恢复和应用版本回退
仍需显式操作。

降级不应由 SupaCloud 猜测执行。应用 release rollback 可以由平台验证并执行，
但不能把 release rollback 与数据库/schema downgrade 绑定；数据库 restore 必须
使用独立、明确的 backup identity 和人工确认。这样可以自动保护可恢复性，但不
会把不可逆的数据变更误判为可逆。

应用隔离预览同样由 SupaCloud 管理分支、队列、配置 revision、测试 secret 名称、
激活和 smoke；CLI 只提供轻量入口：

```bash
supacloud-cli --env test app preview-plan --id reviews \
  --environment_id test --release_id <sha256> --branch_ref pv-review
supacloud-cli --env test app preview-create --id reviews \
  --environment_id test --release_id <sha256> --data_mode schema_only
supacloud-cli --env test app preview-list --id reviews --environment_id test
supacloud-cli --env test app preview-status --id reviews \
  --environment_id test --preview_id <preview-id>
supacloud-cli --env test app preview-cleanup --id reviews \
  --environment_id test --preview_id <preview-id>
```

preview 回执只返回 secret name 和 `value_issued: false`，不返回 secret value。
preview-plan 仅规划隔离资源，不执行配置可用性检查；显式配置 revision 使用
preview-create 的 `--configuration_id`。创建返回 provisioning，不冒充 ready。
创建响应未知时先 preview-list 观察，不盲目重复创建。

应用迁移的账本比较不证明 SQL 安全性或可回滚性；执行端仍须使用受控迁移机制重新验证 SQL。
operator provisioning、业务验收与数据恢复属于独立检查，不能由账本匹配代替。
源 smoke 最大有效期 30 分钟，未来时间拒绝；服务端固定该策略，调用者不能放宽。
smoke 证据还必须绑定当前迁移账本摘要。自动观测器当前不执行业务 smoke，
因此其 `authenticated_smoke=unknown` 不能使源环境通过提升检查。

已部署相同制品和配置，且目标当前激活回执、readiness、smoke 与迁移均匹配时，
返回 no-op。否则仍需提升或验证，不以“目标已有制品”代替“目标运行正确”。
计划 SHA-256 绑定全部观察身份、配置元数据、账本摘要和源/目标 smoke 证据摘要。
执行时必须重新计算计划和 CAS；计划不是可复用写令牌。

目标配置默认观察目标环境的当前版本；可用 `--configuration_id` 指定不可变版本。
缺失的显式版本也保留请求 ID，返回配置缺失的阻断计划，不推断或复制源配置。
配置检查仅覆盖元数据和 target/host/Bun 绑定；实际值与应用兼容性仍由激活端验证。

## 验收场景

```gherkin
Scenario: 只读计划
  Given 已验证的源制品和独立目标环境
  When 用户生成提升计划
  Then 不复制制品、配置、密钥或数据
  And 不执行 SQL、备份、激活或恢复

Scenario: 源环境有成功证据
  Given 源 activation 未成功、readiness 非 ready 或 smoke 已过期
  When 用户生成提升计划
  Then 返回明确阻断原因
  And 不根据当前进程存在猜测成功

Scenario: 回执不能代替完整账本证明
  Given 回执表面成功但资源键、检查点、请求指纹或当前配置不匹配
  When 平台验证源或目标激活
  Then 不确认该环境的成功激活证据
  And 源证据无效时阻断提升，目标证据无效时不能报告 no-op

Scenario: 任一环境存在未完成写操作
  Given 源或目标在六个检查点中的任意一处有未完成 mutation
  When 用户生成提升计划
  Then 返回 APPLICATION_PROMOTION_BUSY
  And 不返回 promote 或 no-op 计划

Scenario: 目标配置与数据库独立
  Given 源与目标使用独立配置和数据库
  When 平台比较相同源制品
  Then 使用目标配置和目标迁移账本
  And pending 迁移列出备份和受控迁移步骤
  And 冲突和缺少绑定阻断计划

Scenario: 完整 no-op
  Given 目标已有相同 release 和配置且成功回执、readiness、smoke、迁移均匹配
  When 用户生成提升计划
  Then 返回 no-op 和空执行步骤
  And 仅有制品不能返回 no-op

Scenario: 观察漂移与授权
  Given 源或目标在观察期间改变 activation、配置或运行证据
  When 平台生成计划
  Then 拒绝返回混合观察结果
  And 源读取权限与目标读取权限分别验证

Scenario: CLI 跳过无变化的写请求
  Given 完整计划为 no-op
  When 用户执行 app promote
  Then 只读取计划且不生成 mutation 或提交 POST

Scenario: 未知提升结果
  Given 唯一一次提升 POST 丢失最终响应
  When CLI 报告 OUTCOME_UNKNOWN
  Then 保留原 mutation ID
  And 不重复 POST、不恢复数据、不执行降级
  And 原 principal 可以读取状态或显式请求观察恢复

Scenario: Preview 隔离与保密
  Given 创建隔离 preview
  When CLI 接收回执
  Then 校验项目、应用、环境和 preview 身份
  And 返回 provisioning 状态并拒绝包含 secret value 的响应
```
