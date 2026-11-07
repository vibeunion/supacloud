# Pigsty 备份与恢复运维

[English](pigsty-backup-operations.md) | [简体中文](pigsty-backup-operations.zh-CN.md)

SupaCloud 基于 Pigsty 的 PostgreSQL 备份底座构建。平台并不替代 pgBackRest 或 `pig pitr`；平台负责校验其状态，并将结果记录为 SupaCloud 就绪度契约。

## 职责划分

Pigsty / pgBackRest 负责：

- PostgreSQL 物理全量、差异和增量备份
- WAL 归档与基于时间点的恢复（PITR）
- 仓库（repository）配置与备份保留策略
- 集群恢复期间的 Patroni 状态协调

SupaCloud 负责：

- 失败关闭（fail-closed）的可用性检查
- 租户/项目 API 访问授权与租户隔离
- 备份与恢复操作回执（operation receipt）
- 恢复后的组件健康状态回读（read-back）
- 对象存储、Secret 密钥、运行时元数据和租户隔离验证

## 配置参数

安装器会将以下配置持久化到 `/etc/supabase/install.env` 或 Management API 运行环境变量中：

```text
SUPACLOUD_PGBACKREST_CONFIG=/etc/supabase/pgbackrest.conf
SUPACLOUD_PGBACKREST_STANZA=db-main
SUPACLOUD_PGBACKREST_USER=postgres
SUPACLOUD_PGBACKREST_BIN=pgbackrest
SUPACLOUD_PITR_ENABLED=true
```

上述配置必须指向 Pigsty 管理的仓库。本地 PostgreSQL 进程正常运行并不代表备份仓库可用。

## 就绪度检查

在管理宿主机上执行：

```bash
sudo /usr/local/libexec/supacloud/backup_manager.sh verify
```

该命令会输出一条 JSON 格式的就绪度记录，包含：

- `schema`
- `provider`
- `stanza`
- `repository_count`
- `completed_backup_count`
- `latest_completed_backup`

如果 pgBackRest 缺失、stanza 不健康、仓库状态与 stanza 状态冲突或清单无法读取，命令会以非零状态码退出。平台绝不会将不可用的 Provider 伪造成空的备份列表。

在发布或升级门禁中，再执行 SupaCloud 的确定性验收器：

```bash
bun scripts/verify-pigsty-backup-acceptance.ts \
  --max-age-seconds 86400
```

验收器要求 Provider、仓库和最近一次已完成备份同时存在，并把过期、缺失或非
`pigsty.pgbackrest` 的输入判为 `incomplete`。没有目标主机和真实 pgBackRest 回读时，
只能用 `--input` 做格式测试，不能把测试回执当作生产恢复证据。

## 备份与 PITR 恢复

```bash
sudo /usr/local/libexec/supacloud/backup_manager.sh create db-main full
sudo /usr/local/libexec/supacloud/backup_manager.sh create db-main incr
sudo /usr/local/libexec/supacloud/backup_manager.sh restore \
  2026-09-06T12:30:00Z
```

`create` 会在命令返回后对 pgBackRest 清单进行校验。
`restore` 要求 `SUPACLOUD_PITR_ENABLED=true`，调用 Pigsty 的 `pig pitr`，且仅在命令成功退出后才报告成功。

在普通生产使用中，推荐使用已认证的 Management API：

- `GET /v1/projects/:ref/database/backups`
- `POST /v1/projects/:ref/database/backups`
- `POST /v1/platform/backups/restore`

Management API 会额外应用项目/管理员授权、确认字符串（confirmation string）、并发恢复防重保护以及结构化错误响应。

## 企业级恢复演练

Pigsty 备份就绪度仅仅是数据库层的门禁。一次完整的 SupaCloud 恢复演练还必须包含：

1. 从独立的异地仓库位置验证所选备份。
2. 恢复数据库并记录实际恢复时间戳。
3. 恢复项目的对象存储数据与运行时元数据。
4. 对齐数据库迁移（migrations）与组件版本。
5. 验证 Management API、Caddy、PostgREST、GoTrue、Edge Runtime、Realtime 与 pgredis 的健康状态。
6. 验证已认证请求成功，以及跨租户访问被拦截拒绝。
7. 记录实测 RPO、RTO、备份标识及未解决的偏差。

仅凭 `pgbackrest info` 成功、健康的 Patroni 主节点或数据库单层 PITR 成功，均不能作为 SupaCloud 完整恢复验收的充分条件。
