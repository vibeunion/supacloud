# 平台安装与运维

[English](platform-operations.md) | [简体中文](platform-operations.zh-CN.md) · [项目概览](../README.zh-CN.md)

本文整理原根目录 README 中的完整平台入口。Lite 的单进程状态、升级与快照请参阅 [Lite 指南](../packages/supacloud-lite/README.md)。

## 安装前准备

先查看 [setup.sh](../setup.sh) 与 [install.sh](../install.sh) 中支持的主机及组件前提条件。按项目数量和工作负载规划 CPU、内存和磁盘；最低安装占用不等于生产容量保证。准备好 DNS、TLS 可达性、可信运维访问与恢复方案。

受版本控制的 [config.env](../config.env) 提供默认值。安装输入保存在 `/etc/supabase/install.env`，Management API 运行时配置独立保存在 `/etc/supabase/management-api.env`，不要相互覆盖。配置与 Release 信任边界见[部署指南](deploy-guide.md)。

## 带验证的安装

以 root 身份执行前应先阅读安装脚本。引导脚本直接从官方仓库获取：

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh | sudo bash
```

运维者可为后续 GitHub Release/API 下载显式配置可信回退代理：

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

不要用第三方代理包装 root 引导脚本 URL。网络 Release 产物必须验证 SHA256 与构建来源证明，代理不能替代验证。离线验证使用经审查并固定的 Sigstore 信任根，不依赖实时 TUF 网络出口。不要通过关闭验证完成正常安装。

### 源码与开发环境安装

源码检出不包含 Release 产物。启用本地产物模式前，必须构建 Management API、Edge Runtime、pgredis-runtime、定制 Caddy 和 Web Console。遵循各包脚本及 [Management API CI](../.github/workflows/management-api.yml) 的依赖安装顺序，只构建 Management API 不够。[Caddy 构建脚本](../scripts/build_supacloud_caddy.sh)记录了工具链版本。

仅在所有本地产物均已生成并通过对应检查后，才能在仓库根目录执行：

```bash
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 203.0.113.10 --domain api.example.com --s3 juicefs
```

IP 与域名为占位值。生产主机通常应使用经过验证的 Release，而不是不完整的源码检出或未经验证的本地构建。本次文档修改不构成新的源码构建验收结果。

## CLI 连接

项目 CLI 使用 `SUPABASE_URL` 或 `SUPACLOUD_API_URL`，以及 `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPACLOUD_API_TOKEN` 连接，可从当前工作区 `.env` 自动绑定。凭据不得进入代码仓库或浏览器产物。生成应用的环境包装器使用独立的选择契约，详见[应用模板指南](application-starter.md)。

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
```

npm 入口默认使用 Node.js。需要显式使用 Bun 时，包括 Windows 终端，可运行：

```bash
bunx --bun --package @supacloud/cli supacloud-cli status
```

AI Agent 可先预览，再安装 CLI 随包提供的 migration-first Skill：

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

按 [CLI 指南](cli-guide.md)配置运维连接后，使用 Admin 执行主机与平台操作：

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
```

`supacloud-cli` 限定在项目范围。安装、升级、SSH 诊断及平台项目生命周期属于 `supacloud-admin`。`supacloudctl` 是可选分发入口；`supacloud` 指服务端二进制，不是项目 CLI 的别名。

## 生产升级

先查看[组件升级说明](platform-component-upgrade-notes.md)、迁移与恢复要求，再选择精确且**已发布**的 Management 和 Edge Runtime 版本。仓库包版本号本身不是发布证据。下面的 shell 变量由运维者指定，不是新增平台配置项：

```bash
: "${MANAGEMENT_VERSION:?Choose an exact published Management version}"
: "${EDGE_RUNTIME_VERSION:?Choose an exact published Edge Runtime version}"
npx @supacloud/admin ssh upgrade \
  --version "$MANAGEMENT_VERSION" \
  --edge_runtime_version "$EDGE_RUNTIME_VERSION" \
  --artifact_transport local \
  --github_proxy direct
```

本地传输在 Admin 主机下载精确 Release，验证清单、SHA256、大小、源码提交与架构，再通过 SFTP 上传原子暂存目录。服务器确认 root 所有权后重新离线验证，并以**目标版本** Management 二进制执行事务。本地传输仅接受 `direct` 或 `none`；服务器无需 GitHub/TUF 出口或永久验签器。兼容的已安装 `gh` 会被复用；否则固定版本的临时验签器仅保存在可移除暂存目录内。

Management/Web Console/Edge Runtime 协同升级事务要求已持久化 `EDGE_RUNTIME_MODE=external`。嵌入模式会在协同激活改变产物或服务前被拒绝。Edge 的可执行文件路径、端口、模式和启用状态均被保留。**Caddy 与 GoTrue 不属于该事务，不会被替换。**

远端传输同样使用目标 Management 二进制。本地、远端和直接服务器升级共用非阻塞的主机级锁。若明确只升级 Management 与 Web Console，应使用远端模式并省略 `--edge_runtime_version`：

```bash
: "${MANAGEMENT_VERSION:?Choose an exact published Management version}"
npx @supacloud/admin ssh upgrade \
  --version "$MANAGEMENT_VERSION" \
  --artifact_transport remote
```

### 观察与回滚

服务器事务运行于唯一命名的临时 systemd 单元，并发布受保护的原子状态。Admin 通过短 SSH 调用观察，最长 30 分钟。**观察超时不等于事务停止，也不证明升级失败。** 重试前先检查输出中的 unit、stage、status、log 和 upload-drop 路径。激活可能仍在进行时，不要删除暂存目录或启动冲突升级。

生产服务器升级不需要 `git pull` 应用源码。不要依赖旧版已安装二进制实现新版激活契约。产物回滚不会撤销数据库迁移和业务副作用，应遵循组件恢复流程并核实最终状态。

## 交付与运行时边界

前端 Release 使用不可变归档哈希和激活的比较并交换值。函数变更要求提供已观察到的活动版本；正版本号可用于不可变源码备份，`0` 仅作为旧函数的活动版本令牌。过期变更应重新核对，而非盲目重放。完整命令、回执和回滚限制仍见 [CLI](cli-guide.md)、[前端](frontend-hosting.md)与 [Edge Runtime](edge-runtime-guide.md) 指南。

嵌入式 Edge Runtime 由 `supacloud.service` 管理，独立模式使用 `supacloud-edge-runtime.service`，不要同时运行两种模式。公共 `/functions/v1/*` 与 `/realtime/v1/websocket` 请求先进入 Management API，不直接进入 Worker 或 Realtime 内部服务。详见[后台函数](background-functions.md)。

Caddy 路由以经过校验的 JSON 经 Admin API 发布，不通过手工修改生产 Caddyfile 维护。详见[网关归属与恢复](gateway-customization.md)。[pgredis-runtime](pgredis-runtime.md) 是私有数据面：浏览器不访问内部端口，Worker 不接收 PostgreSQL 凭据。PGMQ 仍是平台队列。

## 存储、恢复与可观测性

[项目级 S3](project-scoped-s3.md)与切换实例默认存储不同。必须批准 origin、使用最小权限凭据并验证实际厂商。已绑定后端故障绝不触发回退。已有平台对象需在暂停流量窗口内完成 adoption；不要通过删除绑定或部署不理解该能力的旧版本来修复连接。

[备份运维](pigsty-backup-operations.zh-CN.md)覆盖盘点验证、PITR 规划与恢复演练。[AI 运维 MCP](mcp-ai-operations.zh-CN.md)对写入实行仅计划策略：恢复计划不等于已执行恢复。[可观测性](observability.md)覆盖 VictoriaLogs、进程内采集器、指标、追踪和 Grafana。测试、计划和正常端点不能替代真实工作负载的恢复演练。

[文档索引](README.zh-CN.md)继续提供详细 API、OAuth/OIDC、迁移、任务、扩缩容与故障排查。请使用当前专题文档，不要照搬旧根 README 的示例 Release 版本或历史功能数量。
