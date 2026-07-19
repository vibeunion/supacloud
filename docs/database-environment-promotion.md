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
