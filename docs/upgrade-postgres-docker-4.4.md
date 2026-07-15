# Docker PostgreSQL 4.4 兼容升级

生产三台节点继续使用原生 Pigsty PostgreSQL；本入口只用于 `docker/self-host` 的 PostgreSQL 容器。它复用 SupaCloud 的幂等兼容 SQL，但不会执行 Pigsty、systemd、PgBouncer 或宿主机环境文件修改。

## 检查与升级

先确认 Compose PostgreSQL 容器正在运行，并在执行写入模式前保留逻辑备份：

```bash
cd /path/to/supacloud/docker/self-host
docker compose up -d --build postgres management-api

cd /path/to/supacloud
bash scripts/upgrade_postgres_docker_4_4_compat.sh --check
bash scripts/upgrade_postgres_docker_4_4_compat.sh --dry-run
bash scripts/upgrade_postgres_docker_4_4_compat.sh --apply
bash scripts/upgrade_postgres_docker_4_4_compat.sh --check
```

`--apply` 会在兼容变更前创建 `pg_dumpall` 逻辑备份，并调用 Docker Management API 的 `--init-db` 补齐元数据列和新 API Key。备份默认写入 Compose 项目的 `backups/`，权限为 `0700/0600`；其中可能包含角色口令哈希，应当按数据库备份级别保护。

如果 Analytics 由外部服务写入，必须先独立停写，再执行：

```bash
bash scripts/upgrade_postgres_docker_4_4_compat.sh \
  --prepare-analytics --assume-analytics-stopped
```

没有 `--assume-analytics-stopped` 时，脚本会失败关闭，避免在线复制日志表。
`--prepare-analytics` 只处理备份和 Analytics 迁移，不会执行 Management `--init-db`；完整元数据与 API Key 修复由后续 `--apply` 完成。

## PostgreSQL 大版本安全边界

- 脚本默认要求运行中的 PostgreSQL 为 18，可用 `--expected-pg-major 17` 做兼容测试。
- 脚本永远不会执行 `docker compose down -v`，也不会删除或重建数据卷。
- PG17 到 PG18 不是本脚本负责的原地升级。必须使用新卷配合逻辑 dump/restore，或按 PostgreSQL 官方流程执行经过演练的 `pg_upgrade`。
- `docker/dev` 已改用新的 `pgdata18` volume 名称；旧的 `pgdata` volume 不会被自动删除或挂载。需要保留本地开发数据时，先从 PG17 容器逻辑导出，再恢复到 PG18。
- 回滚只恢复应用/脚本版本和必要的兼容对象；不要自动删除 `_supabase` 数据库或新 API Key 元数据列。

## 与原生 Pigsty 入口的区别

原生生产节点继续使用：

```bash
bash scripts/upgrade_pigsty.sh
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --check
```

不要在 Docker PostgreSQL 上运行 `upgrade_pigsty.sh`，也不要把 Docker volume 当作 Pigsty 数据目录使用。
