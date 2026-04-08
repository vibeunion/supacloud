# @supacloud/mcp-server

AI-native 的 Supabase 基础设施管理 MCP Server。让 AI Agent（Claude、Cursor、Windsurf、Gemini 等）直接通过对话管理你的自托管 Supabase 平台。

## 特性

- 🔧 **安装前可用**：通过 SSH 远程安装 SupaCloud
- 🚀 **安装后增强**：通过 Management API 管理项目全生命周期
- 🗄️ **数据库操作**：SQL 查询、Schema 检查、RLS 策略、数据迁移（支持只读模式）
- 🔐 **Auth 管理**：OAuth Provider 配置（含微信/QQ/微博等国内登录）、Auth 设置
- 📦 **存储管理**：S3/MinIO 桶管理、文件操作与 Base64 测试直传
- 🌐 **前端托管**：静态网站 & SSR 部署、Git 部署、自定义域名、HTTPS 自动证书
- 🏗️ **部署管理**：Docker 容器状态检查与 Web Console 部署
- 🔒 **项目范围模式**：限制 AI 只能访问指定项目，支持只读模式
- 🤖 **AI 原生**：带有上下文资源（Resources）与超级智能指引（Prompts）的标准 MCP 协议
- 🔑 **安全可控**：环境变量配置凭据，工具级权限隔离

## 快速开始

### 方式一：远程 MCP 端点（推荐 ⭐）

Management API 内嵌了 Streamable HTTP MCP 端点，无需安装任何东西，一个 URL + Token 即可：

**管理员（完全控制）：**
```json
{
  "mcpServers": {
    "supacloud": {
      "url": "http://your-server:9090/mcp",
      "headers": { "Authorization": "Bearer your-master-token" }
    }
  }
}
```

**项目开发者（只读单项目）：**
```json
{
  "mcpServers": {
    "my-project": {
      "url": "http://your-server:9090/mcp",
      "headers": { "Authorization": "Bearer supa_proj_xxx..." }
    }
  }
}
```

> 💡 项目 Token 可通过管理员 MCP 工具 `create_mcp_token` 生成，或调用 `POST /mcp/tokens`。

### 方式二：npx 本地模式（含 SSH 工具）

适用于需要 SSH 远程安装/诊断的场景：

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

### 方式三：智能本地代理（Auto-Link 🆕）

零配置！自动嗅探当前工作目录 `.env` 中的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，即插即用：

```json
{
  "mcpServers": {
    "supacloud-auto-link": {
      "command": "npx",
      "args": ["-y", "@supacloud/mcp-server", "--local"]
    }
  }
}
```

> 💡 **安全模型**：读操作（查表结构、查数据）自动执行；写操作（INSERT/UPDATE/DDL 等）会在客户端弹出确认对话框，用户同意后才执行。这是 MCP 协议原生的 `destructiveHint` 机制，无需额外配置。

### 2. 开始对话

**全新服务器部署（三步走）：**
```
1. ping_server            → 验证 SSH 连通性
2. setup_server_ssh       → 配置前置环境（SSH自连接 + OpenSSL兼容）
3. install_supacloud      → 一键安装（后台运行，约15-30分钟）
```

**示例对话（安装后）：**

> "帮我创建一个叫 my-app 的项目，开启 Google 和微信登录"

> "查一下 u3gksdpq3r 项目的存储桶和数据库表"

> "列出所有项目的任务队列状态"

> "帮我创建一个 React 前端部署，域名 app.example.com，然后从 GitHub 拉代码部署"

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPACLOUD_HOST` | 服务器 IP / 域名 | (必填) |
| `SUPACLOUD_SSH_USER` | SSH 用户名 | `root` |
| `SUPACLOUD_SSH_PORT` | SSH 端口 | `22` |
| `SUPACLOUD_SSH_KEY` | SSH 私钥路径 | `~/.ssh/id_rsa` |
| `SUPACLOUD_SSH_PASS` | SSH 密码 (备选) | - |
| `SUPACLOUD_API_URL` | Management API 地址 | `http://{HOST}:9090` |
| `SUPACLOUD_API_TOKEN` | Master Token 或 service_role_key | - |
| `SUPACLOUD_PROJECT_REF` | 限定项目 (项目范围模式) | - |
| `SUPACLOUD_READ_ONLY` | 启用只读模式 | `false` |

> 💡 **Auto-Link 模式**下无需手动配置上述变量，系统会自动从 `.env` 读取 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。

## 可用工具（70+ 个）

### SSH 工具（安装前可用）

| 工具 | 说明 |
|------|------|
| `ping_server` | 检测服务器连通性 |
| `setup_server_ssh` | 配置 SSH 自连接 + OpenSSL 兼容性 |
| `install_supacloud` | 一键安装 SupaCloud（后台运行） |
| `upgrade_supacloud` | 升级到最新版本 |
| `diagnose_server` | 系统诊断（内存/磁盘/服务） |
| `ssh_exec` | 执行自定义 Shell 命令 |
| `troubleshoot_install` | 诊断安装/运行故障 |
| `get_container_logs` | 查看容器日志 |

### 多租户运行时工具

| 工具 | 说明 |
|------|------|
| `manage_tenant_runtime` | 管理租户 PostgREST & GoTrue 运行时 |
| `list_tenant_runtimes` | 列出所有租户运行时状态 |
| `diagnose_multi_tenant` | 诊断多租户环境 |
| `inspect_tenant_gateway` | 查看 Kong 声明式路由配置 |
| `migrate_tenant_data` | 在租户数据库之间迁移数据 |

### 项目管理工具

| 工具 | 说明 |
|------|------|
| `list_projects` | 列出所有项目 |
| `create_project` | 创建项目 |
| `get_project` | 获取项目详情 |
| `delete_project` | 删除项目 |
| `pause_project` / `restore_project` | 暂停/恢复项目 |
| `get_project_health` | 健康检查 |
| `fetch_project_logs` | 获取远端容器系统底层的实时日志（auth, api, db） |
| `get_api_keys` | 获取 API 密钥 |
| `restart_project` | 重启所有容器 |
| `get_project_settings` / `update_project_settings` | 获取/更新项目配置 |

### 组织管理工具

| 工具 | 说明 |
|------|------|
| `list_organizations` | 列出所有组织 |
| `get_organization` | 获取组织详情 |

### Auth 登录管理工具 🆕

| 工具 | 说明 |
|------|------|
| `list_auth_providers` | 列出所有 OAuth Provider 启用状态 |
| `get_auth_provider` | 获取单个 Provider 配置 |
| `configure_auth_provider` | 配置 OAuth Provider（GitHub/Google/Apple 等） |
| `update_auth_provider` | 更新 Provider 部分字段 |
| `disable_auth_provider` | 禁用并移除 Provider |
| `list_supported_providers` | 列出所有支持的 Provider（含微信/国内登录） |
| `configure_wechat_miniprogram` | 配置微信小程序登录（自动部署 Edge Function） |
| `configure_wechat_open` | 配置微信开放平台扫码登录 |
| `get_auth_settings` | 获取 Auth 全局设置（SMTP/JWT/会话等） |
| `update_auth_settings` | 更新 Auth 全局设置 |

### 数据库工具（支持只读模式）

| 工具 | 说明 |
|------|------|
| `execute_sql` | 执行 SQL 查询（只读模式仅允许 SELECT） |
| `list_tables` | 列出数据库表 |
| `list_table_columns` | 查看表结构 |
| `list_indexes` | 列出索引 |
| `list_constraints` | 列出约束 |
| `list_extensions` | 列出 PG 扩展 |
| `get_rls_status` | 查看 RLS 启用状态 |
| `list_rls_policies` | 列出 RLS 策略 |
| `list_auth_users` / `get_auth_user` | 查询认证用户 |
| `get_database_connections` | 查看活跃连接 |
| `get_database_stats` | 数据库统计（表大小/行数） |
| `get_slow_queries` | 通过 pg_stat_statements 抓取耗时极高的前 10 条慢查询 |
| `apply_migration` / `list_migrations` | 执行/查看迁移 |
| `get_project_url` | 获取项目 API URL |
| `generate_typescript_types` | 从 Schema 生成 TypeScript 类型 |

### 存储管理工具 🆕

| 工具 | 说明 |
|------|------|
| `get_storage_status` | 获取存储后端状态 |
| `list_storage_buckets` | 列出存储桶 |
| `list_storage_files` | 列出桶中的文件 |
| `upload_base64_file` | 直传 Base64 测试文件到远端存储桶 |
| `delete_storage_file` | 删除文件 |

### 💡 内置智能工作流（Advanced Prompts）

此 MCP 提供高级工作流 Prompt 编排，引导 IDE AI 自动混合本地编辑与远端运维能力：

| Prompt 模板 | 说明 |
|------|------|
| `generate_auth_system` | 为项目自动化实现完整 Auth 架构和 Profiles 触发器闭环 |
| `design_and_save_migration` | 在写数据库前，强制通过编辑器原生能力在工作区 `supabase/migrations` 保留 `.sql` 文件底稿 |
| `generate_mock_data` | 基于反射 Schema，智造海量的高级随机演练假数据，生成出 `seed.sql` 喂入远端数据库 |
| `run_security_audit` | 全盘扫描 RLS 及函数漏洞，一键在本地输出《安全审计报告.md》 |
| `analyze_slow_queries` | 联动底层的慢查询探针检索慢 SQL，AI 思考并立刻补发出 `CREATE INDEX` 优化指令 |
| `setup_scheduled_job` | 面向 pg_cron 的大管家，以自然语言配置定时清理/邮件计划任务 |
| `check_schema_diff` | 虚拟化让 AI 对比本地的 migration 文件夹和远端主库表结构，寻找未同步变动 |
| `sync_local_edge_functions` | 直接读取本地 `supabase/functions/` 目录的 TS 模块，压缩热推云端节点 |

### 任务队列工具 🆕

| 工具 | 说明 |
|------|------|
| `list_project_tasks` | 查看项目任务队列状态 |
| `create_project_task` | 派发异步队列任务（支持派发 AI 生成、MQTT 设备协同等长周期任务） |

### 高级工具

| 工具 | 说明 |
|------|------|
| `list_edge_functions` / `deploy_edge_function` / `delete_edge_function` | Edge Function 管理 |
| `list_secrets` / `upsert_secrets` / `delete_secret` | Secrets 管理 |
| `get_auth_config` / `update_auth_config` | Auth 配置（旧版，建议用新 Auth 工具） |
| `list_backups` / `create_backup` | 数据库备份 |
| `get_system_metrics` | 系统监控 |
| `get_network_restrictions` / `update_network_restrictions` | 网络限制 |

### 前端托管工具 🆕

| 工具 | 说明 |
|------|------|
| `list_frontend_deployments` | 列出项目的前端部署 |
| `get_frontend_deployment` | 获取部署详情 |
| `create_frontend_deployment` | 创建前端部署（static/react/vue/svelte/nextjs/nuxt/astro） |
| `update_frontend_deployment` | 更新部署配置 |
| `delete_frontend_deployment` | 删除部署 |
| `deploy_frontend_git` | 从 Git 仓库部署（克隆→安装→构建→上线） |
| `redeploy_frontend` | 重新构建已有部署 |
| `get_frontend_build_logs` | 查看构建日志 |
| `add_frontend_domain` | 添加自定义域名（自动 HTTPS） |
| `remove_frontend_domain` | 移除自定义域名 |
| `set_frontend_env` | 设置构建环境变量 |
| `list_frontend_frameworks` | 列出支持的框架及默认配置 |
| `list_frontend_records` | 查看部署历史记录 |

### 部署工具

| 工具 | 说明 |
|------|------|
| `deploy_web_console` | 部署/更新 Web Console 前端 |

> 💡 项目范围模式下，数据库工具自动绑定到指定项目，无需手动传入 `ref`。

## 开发

```bash
cd packages/mcp-server
bun install
bun run dev
```

## 安全模型

SupaCloud MCP 使用分层安全模型：

| 认证方式 | 权限范围 | 写操作 |
|---------|---------|--------|
| Master Token | 全局管理员 | ✅ 直接执行（客户端确认） |
| MCP Signed Token | 单项目范围 | 可配置 readonly |
| service_role_key | 单项目范围 | ✅ 客户端确认后执行 |
| anon_key | ❌ 不支持 | - |

所有写操作工具（`execute_sql` 含 DDL/DML、`deploy_edge_function`、`delete_project` 等）均标记了 MCP `destructiveHint: true` 注解。遵循 MCP 规范的客户端（Claude Desktop、Cursor 等）会在执行前自动弹窗让用户确认。

## License

MIT
