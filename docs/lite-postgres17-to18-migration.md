# SupaCloud Lite native PostgreSQL 17 → 18 迁移方案

适用范围：已有的 **native PostgreSQL 17** Lite 项目。目标为 PostgreSQL 18，
默认下载资产为 Theseus `18.6.1`（数据库版本为 18.6，末位是打包修订）。
PGlite、完整 SupaCloud 集群和服务器部署不在本方案的执行范围内。

采用停写窗口内的逻辑迁移：**完整快照 → 17 副本导出 → 独立 18 集群恢复 →
验收 → 切换**。保留原 17 状态和程序用于回滚。
Lite 的 `upgrade` 只备份并执行应用 migrations/seed，不执行 PostgreSQL 主版本转换；
17 的 `pgdata` 和物理快照都不能直接交给 18 启动。

## 1. 迁移前清单与停写边界

- 记录旧 Lite 制品与 SHA-256、PostgreSQL 17 安装、服务启动参数、实际 state/data/storage
  目录、数据库大小及停写窗口。分别校验 PostgreSQL 17、18 的安装与运行库。
- 清点 `pg_extension` 的版本/schema、自定义角色及成员关系、对象所有者、ACL/默认 ACL、
  数据库/角色级 GUC、表空间、编码、locale/provider 和排序规则。18 必须具备匹配的
  扩展 control/SQL/共享库；标准下载包不保证包含 `pg_graphql`、`pgvector` 等扩展。
  若 17 使用真实 PGMQ 扩展，必须恢复兼容的 18 扩展，不能改成 fallback 后继续迁移。
- 下方命令面向 Lite 默认的单个 `postgres` 数据库和默认表空间。其他数据库、自定义
  表空间、外部文件依赖及复制拓扑须先补入迁移清单，不能照抄命令后忽略它们。
- 先在隔离副本演练导出、恢复、验收与回滚，测量时间和磁盘需求。演练成功不等于真实
  业务数据已迁移；正式窗口仍需对最终停写状态重新备份、导出和验证。
- 正式窗口阻断业务写入，停止 Lite 及自动重启机制、函数/worker/队列消费者、外部写入者、
  数据库调度任务和复制消费者。待在途业务收敛，核对未决命令/租约/回执，再确认进程和锁
  已释放。不要删除活跃锁或让两个 Lite 进程共用数据库目录。

## 2. 完整状态备份，并从快照建立 17 副本

以下为 **人工运维命令示例**，需在同一 Bash 会话执行。先替换路径，使用原数据目录的
非 root 属主运行；备份目录不得位于源/目标 state/data/storage 中。文档与 PR 合并本身
不会执行这些命令，也没有指定任何生产实例。

```bash
set -euo pipefail
umask 077

PROJECT_DIR=/srv/my-lite-project
SOURCE_STATE="$PROJECT_DIR/.supacloud-lite"
SOURCE_DATA="$SOURCE_STATE/pgdata"
SOURCE_STORAGE="$SOURCE_STATE/storage"
OLD_LITE=/opt/lite-old/supacloud-lite
NEW_LITE=/opt/lite-candidate/supacloud-lite
PG17=/opt/postgresql/17
PG18=/opt/postgresql/18
WORK=$(mktemp -d /srv/lite-pg18-migration.XXXXXX)
BACKUP="$WORK/backup"
CLONE_STATE="$WORK/source17-state"
TARGET_STATE="$WORK/target18-state"
TARGET_DATA="$TARGET_STATE/pgdata"
install -d -m 700 "$BACKUP"

test "$(cat "$SOURCE_DATA/PG_VERSION")" = 17
test -s "$SOURCE_STATE/secrets.json"
"$PG17/bin/postgres" --version
"$PG18/bin/postgres" --version
"$PG18/bin/pg_dump" --version
"$NEW_LITE" version

"$OLD_LITE" snapshot create --engine native \
  --project-dir "$PROJECT_DIR" --state-dir "$SOURCE_STATE" \
  --data-dir "$SOURCE_DATA" --storage-dir "$SOURCE_STORAGE" \
  --storage-backend fs --postgres-dir "$PG17" \
  --output "$BACKUP/native17-state.tar.gz"

"$NEW_LITE" snapshot restore "$BACKUP/native17-state.tar.gz" --engine native \
  --project-dir "$PROJECT_DIR" --state-dir "$CLONE_STATE" \
  --data-dir "$CLONE_STATE/pgdata" --storage-dir "$CLONE_STATE/storage" \
  --storage-backend fs --postgres-dir "$PG17"
```

示例为 `fs` Storage，快照包含数据库、对象字节和 `secrets.json`。自定义路径必须使用实际
路径。S3 模式创建和恢复均改用 `--storage-backend s3`，并另行保全远端对象/版本与
bucket/prefix 清单；Lite 快照只保存数据库元数据和密钥，不复制 S3 对象。

另行保全 `supabase/`（迁移、函数、配置、seed）、身份模块、环境/服务配置及 TLS、外部
密钥的恢复途径；它们不都在 Lite 快照内。将快照和后续 dump 加密备份到异机，并保存
校验和。备份和 `secrets.json` 均按凭据处理，不打印内容或提交到 Git。

## 3. 从 17 副本逻辑导出

Lite 的 native 引擎使用随机私有 Unix socket。停止 Lite 后，以 `pg_ctl` 启动上述 **17
副本**，获得明确的导出连接；不要猜测运行中 Lite 的 socket，也不在原目录重新启动数据库。
检查副本配置，禁用调度/复制和其他外部副作用，替换依赖原机器路径的设置。
下方关闭 preload 并只开放私有 socket；有特定 preload 要求的扩展须在演练时制定配置。

```bash
SOCK17=$(mktemp -d /tmp/sclm17.XXXXXX)
chmod 700 "$SOCK17"
"$PG17/bin/pg_ctl" -D "$CLONE_STATE/pgdata" -l "$WORK/source17.log" \
  -o "-k $SOCK17 -p 55417 -c listen_addresses='' -c shared_preload_libraries=''" \
  -w start

"$PG18/bin/pg_dumpall" -h "$SOCK17" -p 55417 -U postgres \
  --roles-only --file "$BACKUP/roles17.sql"
"$PG18/bin/pg_dump" -h "$SOCK17" -p 55417 -U postgres -d postgres \
  --format=custom --no-subscriptions --file "$BACKUP/postgres17.dump"
"$PG18/bin/pg_restore" --list "$BACKUP/postgres17.dump" > "$BACKUP/restore-toc.txt"

"$PG17/bin/pg_ctl" -D "$CLONE_STATE/pgdata" -m fast -w stop
```

使用 **18 的 pg_dump** 读取 17，保留所有业务/系统应用 schema，例如 `auth`、`storage`、
`supabase_migrations`、队列、workflow、命令/幂等回执和 Vault；不加 `--no-owner`、
`--no-acl`，不只导出 `public`。同时保留与最终 dump 同一停写状态的验收基线。

安全审阅 `roles17.sql`，生成 `$BACKUP/roles-reviewed.sql`：避免重复创建目标 initdb
已经建立的 `postgres` 及内置角色，核对其属性、密码策略和角色 GUC；保留应用角色的
成员关系、所有权与权限。角色文件可能含密码哈希，必须留在受控目录中。
不能用“忽略 SQL 错误”替代审阅。

订阅被明确排除；WAL/复制槽位置不能按物理偏移继承到 18。PowerSync/逻辑复制在切换后
按新集群建立槽和检查点，执行受控全量重同步，并验证消费者进度。连接目标、发布和
后台任务配置必须先审核，再启用。

## 4. 恢复到空的 PostgreSQL 18 集群

目标使用新目录和原 `secrets.json`，保留 JWT、会话和 Vault 解密身份；此次迁移不顺便
轮换密钥。`fs` 对象从同一快照复制；S3 对象的保全/演练隔离按第 2 节单独处理。
不能先启动 Lite 或运行 `migrate` 来 bootstrap/seed 目标数据库，再叠加整库恢复。

```bash
test ! -e "$TARGET_STATE"
install -d -m 700 "$TARGET_STATE"
install -m 600 "$CLONE_STATE/secrets.json" "$TARGET_STATE/secrets.json"
cp -a "$CLONE_STATE/storage" "$TARGET_STATE/storage"
cmp -s "$CLONE_STATE/secrets.json" "$TARGET_STATE/secrets.json"

# 编码与 locale/provider 需按已记录的源设置确定；目标须支持 dump 中的数据库 locale。
"$PG18/bin/initdb" -U postgres -A trust -E UTF8 -D "$TARGET_DATA"
test "$(cat "$TARGET_DATA/PG_VERSION")" = 18
SOCK18=$(mktemp -d /tmp/sclm18.XXXXXX)
chmod 700 "$SOCK18"
"$PG18/bin/pg_ctl" -D "$TARGET_DATA" -l "$WORK/target18.log" \
  -o "-k $SOCK18 -p 55418 -c listen_addresses='' -c shared_preload_libraries=''" \
  -w start

"$PG18/bin/psql" -X -h "$SOCK18" -p 55418 -U postgres -d template1 \
  --set ON_ERROR_STOP=1 --file "$BACKUP/roles-reviewed.sql"
"$PG18/bin/pg_restore" -h "$SOCK18" -p 55418 -U postgres -d template1 \
  --create --clean --if-exists --exit-on-error "$BACKUP/postgres17.dump"
"$PG18/bin/vacuumdb" -h "$SOCK18" -p 55418 -U postgres -d postgres --analyze-in-stages
```

`pg_restore` 在 **新建的 18 集群** 中通过 `template1` 连接重建 `postgres` 数据库，保留
数据库级配置与对象权限；`--clean` 绝不能指向原 17 或其他已有实例。使用 `--create`
时不加 `--single-transaction`；若失败，保留日志、停止目标并重新准备一个空目标，
不能忽略错误后切换。磁盘空间不足、缺扩展、collation 差异和恢复错误均为停止条件。

核对扩展版本/ABI、所有者、ACL/默认 ACL、RLS 与 GUC。排序规则版本改变时，按对应
PostgreSQL/扩展升级要求处理索引并验证唯一性；不要只刷新版本号来消除告警。
恢复和 SQL 验收完成后，停止这个临时数据库，才可让 Lite 取得目标目录：

```bash
"$PG18/bin/pg_ctl" -D "$TARGET_DATA" -m fast -w stop
```

## 5. 验收、切换和回滚

| 验收项目 | 必须满足的结果 |
| --- | --- |
| 数据与账本 | 所有用户表行数、关键业务数据校验和、序列状态、迁移 SQL/版本、未决命令和幂等回执与停写基线一致 |
| 身份与密钥 | Auth/identity/refresh-token 数据、原 JWT 会话、退出/刷新、Vault 解密均正常；密钥文件比对一致 |
| 权限 | 所有者、角色属性/成员关系、ACL/默认 ACL、anon/authenticated/service_role 的 RLS 行为符合源约束 |
| Storage | bucket/对象元数据与对象字节/校验和一致；S3 恢复位置、版本与外部配置已确认 |
| 功能 | 在隔离副本验证函数、队列/workflow/命令、Realtime、启用的 GraphQL 和扩展查询，且重启后数据仍在 |
| 运维 | 新目录权限、备份恢复、告警、容量和性能满足上线门槛；复制/外部消费者按新检查点验证 |

记录恢复日志、校验和、差异、耗时、RPO/RTO 和切换负责人。独立演练中的探测写入不得
进入最终业务数据；触发外部系统的函数、webhook、Storage/S3 和消费者必须使用隔离目标。

正式恢复验收通过后，准备候选服务的配置，显式绑定：

```bash
"$NEW_LITE" start --engine native --project-dir "$PROJECT_DIR" \
  --state-dir "$TARGET_STATE" --data-dir "$TARGET_DATA" \
  --storage-dir "$TARGET_STATE/storage" --storage-backend fs --postgres-dir "$PG18"
```

先在维护模式下检查候选服务。启动前审查应用 migrations/seed、身份和外部运行时配置；
若存在待执行应用变更，单独审查其影响，不在数据库迁移中盲目重放 seed。
所有服务启动参数/环境变量与反向代理必须一起切换到 18 目标；确认数据库进程仍只使用
私有 socket，按受控顺序恢复业务流量和消费者。旧进程的自动重启继续禁用，杜绝双写。

**放行业务写入前**，如果验收不通过，停止候选及其消费者，恢复旧服务参数，使用保留的
原 17 安装、旧 Lite、原状态和对象配置恢复服务；必要时把 17 快照恢复到新的空目录。
不得将 18 数据目录交给 17，也不能在不确认原目录状态时使用 `--force` 覆盖它。

**18 已接收业务写入后**，原 17 副本已落后。再次停写、备份 18，并制定新增数据的
反向逻辑迁移/业务补偿及核对方案；只有验证数据和外部副作用已对账后才能回切。
此阶段优先评估在 18 修复前进，不能通过恢复旧快照静默丢弃新增写入。

保留 17 制品、原目录/快照、逻辑 dump、Storage 副本与迁移证据，直到约定观察期结束且
18 的备份恢复验收通过，再按保留策略清理。此次 PR 的新库 smoke 和快照兼容回归仅验证
代码基线，不代表任何现有项目已完成上述迁移演练或线上验收。

参考：[PostgreSQL 主版本升级](https://www.postgresql.org/docs/18/upgrading.html)、
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)、
[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)。
