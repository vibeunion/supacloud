# 应用预览流程

目标：用户从已发布制品创建隔离预览、查询进度、显式恢复中断任务并清理资源，
不在应用仓库维护分支、队列或测试 token 的编排脚本。

默认输出仅显示环境、预览身份和状态；完整资源回执由 `--json` 返回。
schema-only 是默认数据策略，full-clone 必须显式选择。
创建、恢复和清理属于写操作，受环境、只读模式和生产确认门禁约束。
状态查询不恢复任务、不创建资源、不复制配置。
响应丢失时保留同一个 preview ID，并查询它，不自动重新创建预览。

```bash
supacloud-cli --env staging app preview-plan --id reviews --environment_id test --release_id <sha256>
supacloud-cli --env staging app preview --id reviews --environment_id test --release_id <sha256>
supacloud-cli --env staging app preview-list --id reviews --environment_id test
supacloud-cli --env staging app preview-status --id reviews --environment_id test --preview_id <uuid>
supacloud-cli --env staging app preview-reconcile --id reviews --environment_id test --preview_id <uuid>
supacloud-cli --env staging app preview-cleanup --id reviews --environment_id test --preview_id <uuid>
```

`preview` 默认生成 ID，CI 可传入固定 `--preview_id`；相同请求重新提交只观察已有回执，
不同配置、环境、数据策略或制品身份不能复用该 ID。CLI 先读取源制品确认
manifest，再验证创建回执的分支制品绑定；一次请求仅发送一次创建 POST。
API 查询、列表和规划为纯只读；只有 POST reconcile 可以恢复 provisioning。
规划结果不执行资源创建，也不是可复用写令牌。
preview plan 的 `release_id` 是绑定源 manifest 的候选分支制品身份，
不是把父环境 release ID 直接当成分支制品。

创建回执先于制品物化持久化；并发相同请求共享已保存的身份，
不再从创建入口重复启动任务。分支记录持有父项目和完整 preview ID，
相同截断前缀不能接管或删除其他预览的分支。没有归属标记的旧分支不会被自动接管。
已确认的队列和测试 secret 在恢复时不会重新创建或轮换。

有 activation 的预览只有在 `retireConfigured` 已确认停止、路由引用消失且
资源分配已退役后才能删除数据库。清理还会由 SupaCloud 自动确认运行时停止、
队列不存在、测试 secret 删除、环境缓存失效、对象存储为空以及数据库已消失；
任一确认失败都会保留分阶段回执，允许再次执行 cleanup。仍活跃的应用会返回
`APPLICATION_PREVIEW_RETIREMENT_REQUIRED`，不会自动强制关停。
清理中的回执先变为不可用状态，避免查询把它误报为 ready；中断的 provisioning
会返回 `APPLICATION_PREVIEW_PROVISIONING_UNRESOLVED`。
原始资源回执会保留；CLI cleanup 返回非成功，而不是假报已清理。

## 验收场景

```gherkin
Scenario: 创建身份稳定
  Given 一个显式或由 CLI 生成的 preview ID
  When 平台接受创建请求后响应丢失
  Then CLI 返回原始 preview ID 与未知结果
  And 不自动重发创建请求

Scenario: 查询只读
  Given provisioning 状态的预览
  When 用户查询预览或列表
  Then 只读取已有回执
  And 不启动或恢复分支、队列、密钥或应用激活

Scenario: 恢复独立授权
  Given 中断的 provisioning 回执
  When 用户显式恢复该预览
  Then 恢复入口使用写权限
  And 复用已持久化的配置版本和 activation ID

Scenario: 拒绝错误回执
  Given 响应属于其他项目、应用、环境或 preview ID
  When CLI 接收该响应
  Then 不显示成功
  And 不暴露响应中的额外字段或密钥

Scenario: 清理需要退役证据
  Given 曾经创建过应用 activation 的预览
  When 运行时停止和路由移除尚未证明
  Then 保留预览和数据库
  And 回执明确标记退役前置条件
```

当前实现不承诺自动数据恢复、生产 smoke 验收、旧平台兼容或线上性能。
完整预览退役执行、资源保留策略和独立业务验收必须继续补齐。
对象存储非空时暂不强制删除，需独立的资源保留/清理策略。
分支项目存在但 provisioning 完成尚未落盘时，也不会推断数据库已准备完成；
数据库删除或项目软删除已成功但最终预览回执落盘失败的窗口仍需独立恢复机制。
