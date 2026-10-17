# 应用版本回滚

应用回滚重新激活保留的不可变制品和配置版本，不恢复数据库、业务状态或 Storage。

```bash
supacloud app rollback-plan --id reviews --environment_id test
supacloud app rollback --id reviews --environment_id test
```

默认目标只取自当前成功 activation journal 的 `previous`，不按创建时间或 release 列表排序猜测。平台校验当前与上一个 activation 的 scope、资源标识、请求指纹和成功回执，以及保留制品、配置摘要和当前网关路由。存在未决 activation、缺失或损坏的证据时，快照接口拒绝给出回滚目标。

CLI 自动生成新的 activation UUID，用快照中的当前 activation 作为 CAS，并沿用上一个不可变 configuration revision。执行仍走现有平台激活流程，重新校验当前数据库兼容性、Worker 退役约束、端口分配、readiness 和路由回读。快照只是目标选择证据，不表示旧版本已经通过当前 schema 的兼容性检查。

快照采用乐观观察，不持有发布锁。前后检查未决 mutation 并回读 authority/journal 可以发现观察期间的漂移；快照返回后仍可能发生新发布。实际 activation 的资源占用与 CAS 门禁负责拒绝过期目标，CLI 不在冲突后重新选择并自动重试。显式传入的 UUID 不得复用快照中当前或上一个 activation 的身份。

请求超时或响应无法验证时，CLI 保留新 activation UUID、选中的 release/configuration 和 CAS，不自动重复 POST。先观察和 reconcile 同一个 activation；不要重新执行默认回滚来猜测第一次请求的结果。回滚计划接口本身不启动/停止进程，不分配端口，不写配置、网关、authority 或 mutation journal。

显式指定保留版本仍可使用：

```bash
supacloud app rollback --id reviews --environment_id test \
  --release_id <sha256> --configuration_id <uuid> \
  --expected_activation_id <current-uuid>
```

`--activation_id <uuid>` 可显式传入稳定的操作身份。默认回滚不能混用手填 configuration/CAS；需要完整显式目标时应同时指定 `release_id`。

## 验收场景

```gherkin
Scenario: 平台选择上一个成功版本
  Given 当前 authority 和成功 journal 一致且存在已验证的 previous
  When 用户执行 app rollback
  Then CLI 使用平台选中的 release/configuration 和当前 CAS
  And 只发出一次新 activation POST

Scenario: 不猜测旧版本
  Given 当前 activation 无 previous 或缺少成功 journal
  When 用户查看回滚计划或执行默认回滚
  Then 平台不扫描 release 列表
  And CLI 不发出 activation POST

Scenario: 未决发布或观察漂移
  Given 同一应用环境存在未决 activation 或 authority 在观察期间变化
  When 用户请求回滚快照
  Then 平台拒绝目标选择且不写任何状态

Scenario: 旧制品或配置证据失效
  Given previous 的制品、配置摘要或成功回执无法验证
  When 用户执行默认回滚
  Then CLI 报告错误且不激活

Scenario: 请求结果不确定
  Given activation POST 已发送但成功回执无法验证
  When CLI 返回 OUTCOME_UNKNOWN
  Then 输出保留新 UUID、目标 release/configuration 和 CAS
  And 不自动重放请求或反向迁移数据库

Scenario: 快照返回后发生并发发布
  Given CLI 已读取快照且另一个发布已开始或完成
  When CLI 使用原快照的 CAS 提交回滚
  Then 平台通过资源占用或 CAS 拒绝过期操作
  And CLI 不重新选目标或自动重试
```
