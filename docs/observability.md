# 可选 Grafana 的日志基线

SupaCloud 的默认日志基线是 **VictoriaLogs + 内置采集器**。VictoriaLogs 是单个原生 systemd 服务；日志采集运行在既有的 SupaCloud 管理进程中，不新增 Vector、Logflare、Analytics 或日志采集容器。它独立于 PostgreSQL、Pigsty 和 Grafana，适用于完整平台安装以及单独部署 PostgreSQL 的主机。

```text
systemd journal
  -> SupaCloud 内置采集器
Edge Function .logs
  -> SupaCloud 内置采集器
  -> VictoriaLogs (127.0.0.1:9428, 独立磁盘目录)
  -> VictoriaLogs Web UI / HTTP API
  -> Grafana（可选数据源）
```

## 规范

- 禁止在新安装中部署 Supabase Analytics、Logflare 或其 Vector-to-Logflare 管道。
- `SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK=true` 会被安装器拒绝，因为该旧 Compose 栈会带入 Analytics。
- 不得把日志写入任何业务、租户或管理 PostgreSQL 数据库。
- Grafana 只能作为可选查询和告警界面；日志采集、存储和检索不得依赖 Grafana 存在。
- VictoriaLogs 仅监听 `127.0.0.1:9428`。远程访问必须经受控代理、VPN 或独立的鉴权层，不能直接暴露端口。
- 内置采集器从 journald 中先筛选 SupaCloud、Patroni/PostgreSQL unit，并读取 Edge Function 的 `.logs/*.log`；租户级 GoTrue、PostgREST、Storage unit 和函数日志路径会被解析为 `project_ref` 与 `service`，供项目日志页面隔离查询。
- 内置采集器在持久化前只保留日志正文、时间与 systemd unit，并脱敏 Authorization、Cookie、JWT、token 和数据库 DSN；不得绕过该采集器直接写入日志库。
- 采集游标和函数文件偏移保存于 `/var/lib/supacloud/log-collector/state.json`。写入成功后才前移游标；管理进程重启会从该位置续传。首次启用只回填最近 15 分钟 journald 和每个函数日志文件末尾最多 1 MiB，避免意外全量回灌。

## 默认配置

`config.env` 中的默认值：

- `SUPACLOUD_LOGS_ENABLED=true`
- `VICTORIALOGS_DATA_DIR=/var/lib/supacloud/victorialogs`
- `VICTORIALOGS_RETENTION=7d`

`VICTORIALOGS_DATA_DIR` 只能设置为 `/var/lib/supacloud/` 下的非符号链接目录；安装器会拒绝根目录、`..` 路径和符号链接。管理 API 仅读取允许的 unit 和函数日志文件，不挂载或运行任何额外日志采集容器。

安装器只注册 `supacloud-victorialogs.service` 这一个新增日志服务。可用以下命令检查：

```bash
systemctl status supacloud-victorialogs
curl -fsS http://127.0.0.1:9428/health
```

Edge Function 的函数级运行日志仍写入各项目的 `.logs/<function>.log`，并由管理 API 的函数日志接口读取；内置采集器同时读取这些文件并写入 VictoriaLogs。函数日志路径不依赖 VictoriaLogs 或 Logflare，项目服务日志与 SSE 日志流直接读取 journald。

## 历史主机

旧 Logflare 主机只能通过现有的迁移/清理工具显式处理。新安装调用兼容脚本时固定传入 `--skip-analytics`，不会创建、迁移或重建 Analytics 数据库或容器；不要把旧 Logflare 数据库作为 VictoriaLogs 的数据目录。
