# SupaCloud MCP Server 使用与排障指南

SupaCloud MCP (Model Context Protocol) Server 允许你通过 Claude、Cursor 或 Windsurf 等 AI 助手直接使用自然语言来管理你的私有化 Supabase 平台。

## 一、配置指南

### 1.1 在 Cursor 中配置

1. 打开 Cursor 并在顶部菜单栏选择 **Cursor Settings** (或按 `Ctrl + Shift + J` / `Cmd + Shift + J` 打开 MCP 侧边栏, 进入设置)。
2. 找到 **Features** -> **MCP** -> 点击 **+ Add New MCP Server**。
3. 按照以下方式填写：
    - **Name**: `supacloud`
    - **Type**: `command`
    - **Command**: `npx -y supacloud-mcp`
4. 为该 MCP 配置环境变量（可以在启动时指定或系统环境配置），通常我们在 `cursor` 的环境设置或全局环境中确保以下变量可用，或者你可以针对特定服务器临时使用自定义 MCP 命令，如 `env SUPACLOUD_HOST=x.x.x.x SUPACLOUD_SSH_KEY=~/.ssh/id_rsa npx -y supacloud-mcp`。

### 1.2 在 Claude Desktop 中配置

修改配置项（Windows 下位于 `%APPDATA%\Claude\claude_desktop_config.json`，Mac 位于 `~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "supacloud-dev": {
      "command": "npx",
      "args": ["-y", "supacloud-mcp"],
      "env": {
        "SUPACLOUD_HOST": "1.2.3.4",
        "SUPACLOUD_SSH_USER": "root",
        "SUPACLOUD_SSH_KEY": "/Users/yourname/.ssh/id_rsa",
        "SUPACLOUD_API_TOKEN": "你的_MASTER_TOKEN"
      }
    }
  }
}
```
*注：如果在安装前，`SUPACLOUD_API_TOKEN` 可以留空。安装成功后，请将其填入。*

### 1.3 多服务器 / 多集群管理

SupaCloud MCP 天然支持多路复用。如果你有多台服务器（如测试环境、美东、亚太等），**不需要额外修改代码**，只需要在配置中注册多个同类命令，并分配不同的环境变量即可：

```json
{
  "mcpServers": {
    "supa-us-east": {
      "command": "npx",
      "args": ["-y", "supacloud-mcp"],
      "env": {
        "SUPACLOUD_HOST": "1.2.3.4",
        "SUPACLOUD_API_TOKEN": "token_for_us"
      }
    },
    "supa-ap-asia": {
      "command": "npx",
      "args": ["-y", "supacloud-mcp"],
      "env": {
        "SUPACLOUD_HOST": "5.6.7.8",
        "SUPACLOUD_API_TOKEN": "token_for_asia"
      }
    }
  }
}
```

配置后，你可以直接对 AI 提出定向需求：*"帮我查一下 us-east 的磁盘状态，然后给 ap-asia 区装一套平台"*，AI 会自动帮你分发到对应环境的进程进行执行。

---

## 二、使用场景示例

你可以在 AI 对话框中直接提出以下需求，AI 会自动调用 MCP 工具完成。

### 场景 1：零基础全新安装
> **你**："我刚买了一台服务器，请帮我在这台机器上安装 SupaCloud（数据库密码不用自动生成，帮我设成 `MySuperSecret!23`，域名用 `api.example.com`）。"
> 
> **AI**：(调用 `install_supacloud` 工具) -> 返回部署结果。
>
> ⚠️ **提示**: 如果安装时间较长，AI 会等待命令完成。

### 场景 2：日常租户管理
> **你**："帮我列出现在所有的 Supabase 项目，并创建一个名字叫 `app-prod` 的新项目。"
> 
> **AI**：(依次调用 `list_projects` 和 `create_project`) -> 告诉你创建成功，并附带新项目的 Ref 短信和数据库链接。

### 场景 3：鉴权和高阶功能
> **你**："给刚才创建的 `app-prod` 项目开启 Google 登录，这是我的 Client ID 和 Secret..."
> 
> **AI**：(调用 `update_auth_config`) -> 更新对应参数。

---

## 三、安装与运维故障排查 (Troubleshooting)

在管理开源组件或自托管 PIGSTY + Supabase 的过程中，偶尔可能会遇到意外。我们专门设计了内置排障工具，你可以让 AI 快速定位死结。

### 3.1 自动智能诊断
如果你发现安装 `install_supacloud` 后没跑起来，或者由于网络原因中途卡住导致无法调用 API，直接对 AI 说：
> **你**："安装似乎失败了，去排查一下原因。"
>
> **AI**：将会调用 `troubleshoot_install` 工具。该工具会自动巡检容器、PostgreSQL 存活情况、磁盘空间和网络端口状态，并返回类似以下的报告进行诊断：
> `⚠️ 自动检测到 1 个潜在问题: 容器镜像拉取异常，可能是 registry 配置错误`

### 3.2 提取单容器日志
如果你发现某个特定服务（比如 Analytics）一直不断重启（Exit 1），你可以让 AI 去抓取底层信息：
> **你**："帮我获取一下 `supabase-analytics` 这个容器最近 200 行报错日志吧。"
> 
> **AI**：(调用 `get_container_logs`，参数传入 container="supabase-analytics", lines=200)。

### 3.3 手动清理和重装
通过诊断确认无法修复的基础环境故障（例如硬盘写满或脏数据），可以让 AI 直接执行清理并在清理后重新诊断：
> **你**："服务器太乱了，帮我执行 `bash /tmp/setup.sh uninstall` 然后重新查一遍磁盘空间。"
> 
> **AI**：(调用 `ssh_exec` 取消部署，随后调用 `diagnose_server` 展示新状态)。

### 常用环境排错一览
| 现象 | 排查指令/工具建议 |
|------|-------------------|
| Web 端访问一直卡在 Loading | 调用 `diagnose_server` 检查 `Management API` 进程是否健康 |
| 无法创建新租户 | 可能是 Pigsty DNS 漂移，调用 `troubleshoot_install` |
| 函数执行超时 | 调用 `get_container_logs` 检测 `supabase-edge-runtime` |
| 容器镜像拉取 Error 403 | 调用 `troubleshoot_install` (focus='network') 查询 `docker.io` 封锁与网络限制 |

---

## 四、安全与最佳实践

1. **不可将全局配置文件（含 Master Token）泄露到公共代码库**：保持其在 cursor 或 claude 配置内作为本地密钥。
2. **谨慎使用 ssh_exec**：当 AI 提议使用 `ssh_exec` 执行 `rm -rf` 等破坏性操作时，一定要在点击确认（Approve Tool Call）前仔细审阅其具体的 Command 参数。由于拥有 Root SSH，AI 能修改底层文件。
