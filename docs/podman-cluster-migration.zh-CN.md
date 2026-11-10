# Podman 单机到集群迁移

Podman 负责单节点容器运行和 OCI 物料构建。Podman Pod 不提供跨节点调度、
服务发现、滚动发布、故障重新调度或持久卷编排，因此不把 Podman Pod 当作
SupaCloud 集群控制面。

## 单机路径

生产单机使用 Podman Quadlet 和 systemd：

```text
Quadlet .container/.pod/.network
        ↓
systemd target and health checks
        ↓
one SupaCloud node
```

每个组件保持独立容器和数据目录。Management API、Caddy、PostgREST、GoTrue、
Realtime、Edge Runtime、Worker 和日志组件分别拥有生命周期边界；systemd target
只负责统一启动、停止和状态汇总。

## 集群路径

多节点部署使用 Kubernetes/OpenShift 或另一个明确的集群控制面。SupaCloud 应提供
Helm/Kustomize 资源，至少包含：

- 无状态 Management API、Edge Runtime、Worker 和 Realtime Deployment；
- Caddy/Ingress 与 TLS Secret；
- 项目级 ConfigMap/Secret 和受限 ServiceAccount；
- readiness/liveness/startup probe；
- PodDisruptionBudget、滚动升级和资源配额；
- PostgreSQL、队列和对象存储的外部 endpoint 或经过验收的 operator；
- 数据库迁移 Job 与发布版本的兼容性门禁。

数据库和对象存储不能因为应用服务进入 Kubernetes 就自动变成集群内临时卷。
它们必须使用外部 HA provider、Pigsty，或经过恢复演练的 operator。

## 迁移顺序

1. 在 Podman 单机生成并验证 OCI 镜像和 Quadlet 配置。
2. 将镜像推送到私有 registry，固定 digest，不在集群中使用浮动 tag。
3. 导出项目配置、Secret 引用、迁移状态、数据库备份和对象存储清单。
4. 使用 Helm/Kustomize 在隔离 namespace 部署无状态组件。
5. 先恢复数据库和对象存储，再执行正向迁移 Job。
6. 验证身份、RLS、PostgREST、Storage、Realtime、Functions、Command receipt 和审计。
7. 切换 Ingress 流量，保留单机节点直到恢复验收完成。

`podman kube generate` 可以生成迁移草稿，但生成文件必须经过人工审查；它不能
替代生产 Helm/Kustomize 资源，也不能证明数据库、Secret 或恢复流程已经就绪。

## 当前边界

本仓库先把 Podman Quadlet 作为单机生产路径。集群控制面需要独立的发布、存储、
网络和灾备验收；在这些证据形成前，`cluster` profile 应 fail closed，并指向本
文档，而不是伪装成 Podman Pod 已经提供跨节点能力。
