# 应用环境提升

状态：本次实现只读 `app promote-plan`，提升执行与恢复编排尚未实现。
计划既不是部署回执，也不是线上验收结果，不授权生产变更。

```bash
supacloud-cli --env production app promote-plan --id reviews \
  --environment_id production --source_ref staging \
  --source_environment_id staging --source_release_id <sha256>

supacloud-cli app promote-plan --help
```

`--id` 和 `--environment_id` 选择目标应用及环境；目标项目来自当前 profile，
或在执行策略允许时使用 `--ref`。源项目、环境和不可变版本分别由必填的
`--source_ref`、`--source_environment_id`、`--source_release_id` 指定。
作用域帮助同时列出源、目标和输出参数，不需要先配置 API 凭据。
`--json` 或 `--format json` 返回完整结构化计划，不能将 `--json` 与 `--format text` 混用。

平台验证源制品、当前激活、成功 mutation 回执、实时 readiness 和近期
authenticated smoke 证据；目标使用自己的不可变配置版本、迁移账本和 CAS。
不复制源密钥或配置值，不建立目标制品目录，不执行 SQL、不创建备份、不激活。
计划摘要只包含环境身份、下一步动作和阻断原因。

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
本版本仅规划这些步骤，不会验证或创建备份，`backup.confirmed` 固定为 false。
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
```
