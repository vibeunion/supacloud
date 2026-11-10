# SupaCloud 部署档次

本文定义 Full Platform 的安装档次。目标是让单机和 Podman 安装接近
SurrealDB 的一键体验，同时保留 SupaCloud 的组件隔离、Supabase 兼容性和
PostgreSQL 事务边界。

## 用户入口

推荐的单机安装入口是：

```sh
sudo env SUPACLOUD_DEPLOYMENT_PROFILE=podman bash setup.sh
# 或在仓库/已验证安装目录中：
sudo bash install.sh --profile podman --domain api.example.com
sudo systemctl status supacloud.target
```

Podman 安装器还提供 `--dry-run`、`--no-start` 和 `--skip-build`。组件环境文件、systemd
单元和密钥文件由安装计划生成；用户不需要分别编辑每个
组件的环境文件。

## 三种部署档次

| 档次 | 用途 | 数据库 | 运行方式 | 边界 |
| --- | --- | --- | --- | --- |
| `solo` | 单机、小规模生产 | Podman 管理的本地 PostgreSQL；外部数据库走 `external`/`pigsty` provider | Podman Quadlet + systemd | 无高可用声明 |
| `podman` | `solo` 的显式运行时入口 | Podman 管理的本地 PostgreSQL；外部数据库暂走 Full Platform provider | Podman Quadlet + systemd | 无高可用声明 |
| `pigsty` | 企业自托管和高可用 | Pigsty/Patroni PostgreSQL | systemd/Pigsty | 需要独立恢复和 HA 验收 |
| `cluster` | 多节点部署 | 外部 HA PostgreSQL 或经过验收的 operator | Kubernetes/OpenShift 或其他集群控制面 | 需要独立集群验收 |

也可以使用 `external` 数据库 provider。它必须通过明确的 PostgreSQL URL 绑定，
安装器不能根据本机 `5432` 端口自动采用一个未知数据库。

`solo` 和 `podman` 是同一单机 provider 的产品档次与显式运行时入口，共用同一套
项目、迁移、身份、Storage、Realtime 和 Management API 契约。`Lite` 仍是单项目、
本地优先运行时，不能作为
Full Platform 的生产单机替代品。

## 统一安装计划

安装器先生成一份受版本控制的 `InstallationPlan`，再由对应 provider 执行：

```text
InstallationPlan
  ├── profile: solo | podman | pigsty | external | cluster
  ├── signed component release manifest
  ├── database provider and capability checks
  ├── storage provider and data paths
  ├── gateway/TLS and exposed ports
  ├── root-only secrets
  ├── migration and health-check stages
  └── rollback and recovery metadata
```

`setup.sh` 只负责下载和验证 Admin/Release 物料。实际安装由 Admin 和目标主机上
的受控安装器执行。安装计划必须幂等；失败时保留状态和日志，不报告一个无法证明
完成的安装。

## 单机模式

单机模式默认不安装 Pigsty。若没有显式数据库 URL，安装器创建一个由 SupaCloud
管理的本地 PostgreSQL 实例；该实例使用独立数据目录和 systemd 单元，不启用
Patroni、集群故障转移或多节点声明。

单机模式还应提供本地 Storage provider。它必须具备原子写入、校验、配额、快照和
恢复契约。若当前版本尚未完成本地 Storage provider，安装器应明确要求使用一个
受支持的 S3-compatible provider，不能静默回退到不可持久化的内存存储。

运行组件仍保持独立进程。systemd 可以通过 `supacloud.target` 汇总管理：

```text
supacloud.target
  ├── caddy
  ├── management-api
  ├── postgrest
  ├── gotrue
  ├── realtime
  ├── edge-runtime
  └── worker/cache data plane
```

“一键安装”表示一个安装和运维入口，不表示把所有服务合并成一个不可分别升级
的进程。

## Podman 单机模式

Podman 模式使用 Quadlet `.container`/`.pod` 单元和生成的私有环境文件，当前实现
默认启动本地 PostgreSQL。Podman Quadlet 的外部数据库 unit 尚未完成，因此提供
外部 PostgreSQL URL 时应使用 `external` 或 `pigsty` provider；安装器不会伪装成
已经完成的 external Podman 变体。PostgreSQL 不默认发布到所有主机接口。

Podman 负责进程隔离和本地持久卷，systemd 负责启动顺序、重启和日志；SupaCloud
仍负责项目生命周期、路由、身份绑定、迁移、回执、审计和恢复。Podman Pod 只在
单节点内提供进程分组，不是跨节点集群，也不替代 Pigsty 的 Patroni、pgBackRest
或异地恢复演练。

`podman compose`/`podman-compose` 可以作为开发者迁移工具，但不是生产安装器的
权威编排格式。生产单机路径以 Quadlet + systemd 为准，因为它不依赖一个额外的
Python Compose 实现，也能表达服务依赖、重启和资源限制。

仓库中保留的历史 `docker/` 构建和迁移 fixture 不属于支持的部署入口；新安装器
不会安装 Docker、Docker Compose 或 `podman-docker` 兼容层。

跨节点部署使用 Kubernetes/OpenShift 或其他明确的集群控制面。Podman 可以构建
OCI 镜像并通过 `podman kube generate` 生成迁移草稿，但不负责跨节点调度、服务发现、
滚动升级、故障重新调度或持久卷编排。SupaCloud 的集群档次应提供 Helm/Kustomize
资源，数据库和对象存储继续使用外部 HA provider 或经过验收的 operator。

## 难点和替代方案

| 难点 | 当前替代方案 | 迁移路径 |
| --- | --- | --- |
| 本地 PostgreSQL provider 尚未覆盖所有 Pigsty 扩展 | 使用 Podman 管理的本地 PostgreSQL，或显式绑定外部 PostgreSQL | provider 完成扩展能力矩阵后再启用 native `solo` 默认路径 |
| 本地 Storage 与数据库事务不能天然原子提交 | 使用数据库元数据 + 文件原子 rename/补偿动作；生产使用外部 S3 | 稳定后提供本地 Storage snapshot/import/export 验收 |
| Realtime 仍依赖独立运行时 | Podman 模式保留独立 Realtime 服务；Solo 使用受支持的 systemd 单元 | 不把 Realtime 伪装成 Management API 内存模块 |
| Web Console、Edge Runtime 和 Caddy 版本需要协同 | 发布 manifest 固定组件版本和 digest | 失败时回滚组件，不自动回滚已应用数据库迁移 |
| 企业 HA 不能由单机 Compose 提供 | `pigsty` 档次继续承载 Patroni/pgBackRest/HA | 从 Solo 导出快照，再按恢复手册迁移到 Pigsty |

## 验收场景

```gherkin
Feature: Single-node installation

  Scenario: Clean host without Pigsty or PostgreSQL
    Given a supported Linux host without Pigsty and without a database
    When the operator runs the solo installer
    Then SupaCloud provisions the selected local providers
    And the component target reaches healthy state
    And the operator receives the API, console, backup and recovery locations

  Scenario: Podman single-node installation
    Given a host with Podman and systemd
    When the operator runs the podman profile
    Then Quadlet units start the documented services
    And PostgreSQL is not published on all host interfaces
    And service health checks report the actual state

  Scenario: Explicit external database
    Given the operator provides a PostgreSQL URL
    When installation starts
    Then SupaCloud validates and uses that URL
    And it does not silently bind another local PostgreSQL process

  Scenario: Re-running installation
    Given an existing installation and data directory
    When the same installation plan is applied again
    Then existing secrets and data are preserved
    And only missing or failed stages are reconciled
```

## 生产边界

单机和 Podman 安装完成、健康检查通过或 Podman 启动成功，都不代表已经完成
生产恢复验收。生产声明仍需单独记录数据库迁移、备份新鲜度、恢复演练、对象存储、
身份、跨租户隔离和版本回滚证据。
