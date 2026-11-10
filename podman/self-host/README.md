# SupaCloud Podman 单机安装

这是 SupaCloud 的无 Pigsty 单机安装路径。生产进程由 **Podman Quadlet + systemd** 管理；
安装器不会调用 `podman-compose`，也不会自动回退到 Docker。Compose 文件只能作为开发和
迁移阶段的兼容输入，不能作为生产安装依赖。

## 快速开始

在已经安装 Podman、systemd 和 `podman` Quadlet generator 的 Linux 主机上，以 root 执行：

```bash
sudo ./podman/self-host/install.sh \
  --public-url https://api.example.com \
  --studio-url https://studio.example.com
```

安装器会：

- 创建 `/etc/supacloud/supacloud.env` 和 root-only Secret 文件；
- 创建 `/var/lib/supacloud` 下的数据库、函数、Storage、Caddy 和日志目录；
- 构建本地 Management API、Edge Runtime、pgredis、Caddy 和 PostgreSQL 镜像；
- 安装 Quadlet unit 与 `supacloud.target`；
- 启动 PostgreSQL、GoTrue、PostgREST、Realtime、Management API、Edge Runtime、
  pgredis、VictoriaLogs 和 Caddy。

检查单机安装计划而不写入系统：

```bash
./podman/self-host/install.sh --dry-run --no-start
```

运行状态：

```bash
systemctl status supacloud.target
systemctl list-dependencies supacloud.target
podman ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

停止或启动整套单机服务：

```bash
sudo systemctl stop supacloud.target
sudo systemctl start supacloud.target
```

## 数据库和 Storage 边界

此路径默认使用单个本地 PostgreSQL 实例和本地文件 Storage。它不要求 Pigsty、Patroni、
PgBouncer 或外部 S3。单机 Storage 数据位于 `/var/lib/supacloud/storage`，必须与数据库
一起备份；本地文件系统不提供跨节点复制或自动故障转移。

如果客户已有 PostgreSQL、Pigsty 或 S3，应继续使用 Full Platform 的外部 provider/原生
安装路径。不要把任意监听在本机的 PostgreSQL 自动绑定到 SupaCloud；绑定必须使用显式的
数据库 URL 和经过检查的迁移/权限契约。外部数据库的 Quadlet profile 尚未与本单机 unit
合并时，可先使用 Full Platform 的 provider 路径，避免复制第二套数据库初始化逻辑。

## 组件难点和替代方案

| 组件 | 当前单机方案 | 迁移/替代边界 |
| --- | --- | --- |
| Realtime | 固定版本的官方 Realtime 容器，独立 Quadlet unit | 需要多节点连接迁移、租户级扩缩容或跨区恢复时，迁移到 Kubernetes/Nomad 的 Stateful/Service 编排，不把 Podman Pod 当作集群 |
| Caddy 路由 | Caddy 仍由 Management API 发布经过校验的 JSON | 不要手工编辑运行中的 Caddy 配置；集群环境由网关 Ingress/Gateway 接管，但仍保留同一条路由契约 |
| Storage | 本地文件 provider | 多节点或大对象场景迁移到 S3-compatible provider；必须先完成对象盘点、校验和、adoption 与回滚演练 |
| PostgreSQL 高可用 | 单实例，无 failover 声明 | 迁移到 Pigsty/Patroni、托管 PostgreSQL 或编排平台的 operator；单机 unit 不承担选主和复制 |
| 服务编排 | Quadlet 生成 systemd unit | Quadlet 只解决单节点生命周期；跨节点调度、滚动升级、服务发现、故障转移应迁移到 Kubernetes 或 Nomad |
| 自定义应用镜像 | 本地 `podman build` | 发布时使用不可变 digest 和签名 manifest；不要把源码目录挂载进生产容器 |

## Podman Pod 不是集群

本路径的目标是“一台机器一条命令”，不是跨节点平台。Podman Pod、Quadlet 和 systemd
只负责本机的进程依赖、重启、端口和数据目录；它们不提供：

- 跨节点调度或服务发现；
- PostgreSQL 主备选举和自动故障转移；
- 多节点 Realtime 连接迁移；
- 全局滚动发布和跨节点配额；
- 多副本数据一致性。

当需求出现上述任意一项时，应保留 `Database Contract`、Command、迁移和事件契约，
把运行时组件迁移为 Kubernetes Deployment/StatefulSet/Ingress，或 Nomad Job/Service。
不要把单机 Quadlet unit 直接复制到多台机器后宣称具备集群能力。

## 回滚和数据保护

升级前应先备份 PostgreSQL 和 `/var/lib/supacloud/storage`。更新镜像或 Quadlet unit
可以回滚到旧版本，但数据库迁移和已发生的业务副作用不能假设自动回滚；按对应迁移和
恢复手册执行。`systemctl stop supacloud.target` 只停止运行时，不删除数据目录。
