# 应用制品跨环境转移

同一 Management 平台内，测试和生产可以使用独立项目。已经构建并上传的
不可变应用制品由平台直接转移，CLI 不下载、重新构建或重新上传代码。

```bash
supacloud --env production app transfer-plan --id reviews \
  --source_ref staging --source_release_id <staging-release-sha256>

supacloud --env production --confirm-production production app transfer \
  --id reviews --source_ref staging --source_release_id <staging-release-sha256>
```

目标项目来自当前 profile 或 `--ref`。调用者必须同时拥有目标项目权限和源项目
读取权限；单项目 service role 不能借此读取其他项目。源读取使用源项目的
GET 路径鉴权，不能把目标项目的授权结果当作源授权。

`transfer-plan` 只验证制品，不建立存储目录。目标已有相同且完整的不可变制品时，
`transfer` 返回 no-op，不发出 POST。否则只发出一次转移 POST，绑定源
manifest SHA-256。服务端从已验证的字节快照发布目标制品，不直接复制可变目录。
目标 release ID 按目标项目重新计算，manifest、对象 ID、代码和迁移文件保持不变。
并发转移复用完整的胜出制品；损坏的目标制品会阻断转移，不能被覆盖修复。
默认输出简洁摘要；`--json` 或 `--format json` 保留完整结构化计划或回执。
计划不是可复用的写令牌：执行时重新观察源/目标，并在服务端再次验证源 digest。

普通文件处理使用 Bun API；受信存储发布保留独占创建、落盘和原子 rename。
转移不复制配置、密钥、数据库行或 Storage 对象，不修改迁移账本，不触发激活。
代码制品内嵌的环境专属值不会被平台自动改写，因此应采用环境无关构建。
该接口也不证明源版本已经通过应用 smoke test；后续提升流程仍需绑定源成功激活
证据及测试结果，并使用目标项目自己的配置、迁移计划和部署 CAS。

响应超时、5xx、非完整成功响应或不可验证的成功回执返回 `OUTCOME_UNKNOWN`。
CLI 保留源、目标和 manifest 身份，不自动重复 POST。通过目标项目
`applications get_release --id reviews --release_id <target-release-id>`
观察不可变制品即可，不应因转移响应丢失触发激活或回滚。

## 验收场景

```gherkin
Scenario: 计划不改变平台状态
  Given 源项目存在完整的不可变制品且目标项目尚无制品
  When 用户执行 app transfer-plan
  Then 平台返回按目标项目计算的候选 release ID
  And 不创建目标存储目录、不写配置、不执行代码或 SQL

Scenario: 已有制品直接复用
  Given 目标项目已有相同 manifest 和对象字节且校验成功
  When 用户执行 app transfer
  Then CLI 返回 no-op
  And 不发出转移或 activation POST

Scenario: 原产物跨项目转移
  Given 目标写权限和源读权限均已验证且源 digest 未变化
  When 平台执行制品转移
  Then 从已验证字节快照原子发布目标项目的 release
  And 保持全部对象和 manifest 摘要
  And 不复制源配置、数据库数据或 Storage 对象

Scenario: 拒绝跨项目越权和损坏制品
  Given 源授权失败或源/目标制品损坏或请求 digest 不匹配
  When 用户请求转移
  Then 平台拒绝请求
  And 不覆盖已有制品或触发激活

Scenario: 结果不确定时仅观察
  Given 转移 POST 已发送但回执无法验证
  When CLI 返回 OUTCOME_UNKNOWN
  Then 输出保留源身份、目标 release ID 和 manifest digest
  And 不自动重放 POST、激活、回滚或恢复数据库
```
