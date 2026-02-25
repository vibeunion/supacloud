# @supacloud/mcp-server

AI-native 的 Supabase 基础设施管理 MCP Server。让 AI Agent（Claude、Cursor、Windsurf 等）直接通过对话管理你的自托管 Supabase 平台。

## 特性

- 🔧 **安装前可用**：通过 SSH 远程安装 SupaCloud
- 🚀 **安装后增强**：通过 Management API 管理项目全生命周期
- 🤖 **AI 原生**：标准 MCP 协议，兼容所有主流 AI IDE
- 🔐 **安全可控**：环境变量配置凭据，工具级权限隔离

## 快速开始

### 1. 配置 MCP Client

在你的 AI IDE（Claude Desktop、Cursor 等）的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "supacloud": {
      "command": "npx",
      "args": ["-y", "@supacloud/mcp-server"],
      "env": {
        "SUPACLOUD_HOST": "1.2.3.4",
        "SUPACLOUD_SSH_KEY": "~/.ssh/id_rsa",
        "SUPACLOUD_API_TOKEN": ""
      }
    }
  }
}
```

### 2. 开始对话

安装前：

> "帮我在 1.2.3.4 上安装 SupaCloud，域名用 api.example.com"

安装后（填入 API_TOKEN）：

> "帮我创建一个叫 my-app 的项目，开启 Google 登录"

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPACLOUD_HOST` | 服务器 IP / 域名 | (必填) |
| `SUPACLOUD_SSH_USER` | SSH 用户名 | `root` |
| `SUPACLOUD_SSH_PORT` | SSH 端口 | `22` |
| `SUPACLOUD_SSH_KEY` | SSH 私钥路径 | `~/.ssh/id_rsa` |
| `SUPACLOUD_SSH_PASS` | SSH 密码 (备选) | - |
| `SUPACLOUD_API_URL` | Management API 地址 | `http://{HOST}:9090` |
| `SUPACLOUD_API_TOKEN` | Master Token | - |

## 可用工具

### SSH 工具（安装前可用）

| 工具 | 说明 |
|------|------|
| `ping_server` | 检测服务器连通性 |
| `install_supacloud` | 一键安装 SupaCloud |
| `upgrade_supacloud` | 升级到最新版本 |
| `diagnose_server` | 系统诊断（内存/磁盘/服务） |
| `ssh_exec` | 执行自定义命令 |

### 项目管理工具（安装后可用）

| 工具 | 说明 |
|------|------|
| `list_projects` | 列出所有项目 |
| `create_project` | 创建项目 |
| `get_project` | 获取项目详情 |
| `delete_project` | 删除项目 |
| `pause_project` | 暂停项目 |
| `restore_project` | 恢复项目 |
| `get_project_health` | 健康检查 |
| `get_api_keys` | 获取 API 密钥 |
| `restart_project` | 重启服务 |
| `get_project_settings` | 获取配置 |
| `update_project_settings` | 更新配置 |

### 高级工具（安装后可用）

| 工具 | 说明 |
|------|------|
| `list_edge_functions` | 列出 Edge Functions |
| `deploy_edge_function` | 部署函数 |
| `delete_edge_function` | 删除函数 |
| `list_secrets` | 列出 Secrets |
| `upsert_secrets` | 创建/更新 Secrets |
| `delete_secret` | 删除 Secret |
| `get_auth_config` | 获取 Auth 配置 |
| `update_auth_config` | 更新 Auth 配置 |
| `list_backups` | 列出备份 |
| `create_backup` | 创建备份 |
| `get_system_metrics` | 系统监控 |
| `get_network_restrictions` | 获取网络限制 |
| `update_network_restrictions` | 更新网络限制 |

## 开发

```bash
cd packages/mcp-server
bun install
bun run dev
```

## License

MIT
