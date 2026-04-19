# SupaCloud MCP Server Usage and Troubleshooting Guide

SupaCloud MCP (Model Context Protocol) Server allows you to manage your self-hosted Supabase platform using natural language through AI assistants like Claude, Cursor, or Windsurf.

For human-facing command-line workflows, use the dedicated CLIs instead:

- `@supacloud/cli` / `supacloud`: project-scoped user CLI with local `.env` auto-link
- `@supacloud/admin` / `supacloud-admin`: platform and server administration CLI

## 1. Configuration Guide

### 1.1 Configure in Cursor

1. Open Cursor and select **Cursor Settings** from the top menu bar (or press `Ctrl + Shift + J` / `Cmd + Shift + J` to open MCP sidebar, then enter settings).
2. Find **Features** -> **MCP** -> click **+ Add New MCP Server**.
3. Fill in as follows:
    - **Name**: `supacloud`
    - **Type**: `command`
    - **Command**: `npx -y supacloud-mcp`
4. Configure environment variables for this MCP (can be specified at startup or in system environment config). Usually we ensure the following variables are available in `cursor`'s environment settings or global environment, or you can temporarily use a custom MCP command for a specific server, e.g. `env SUPACLOUD_HOST=x.x.x.x SUPACLOUD_SSH_KEY=~/.ssh/id_rsa npx -y supacloud-mcp`.

### 1.2 Configure in Claude Desktop

Modify config file (Windows: `%APPDATA%\Claude\claude_desktop_config.json`, Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`):

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
        "SUPACLOUD_API_TOKEN": "your_MASTER_TOKEN"
      }
    }
  }
}
```
*Note: Before installation, `SUPACLOUD_API_TOKEN` can be left empty. Fill it in after successful installation.*

### 1.3 Auto-Link 模式（零配置，推荐 ⭐）

如果你在同时开发多个项目，使用 `--local` 模式。它会自动嗅探 `.env` 文件中的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，实现无缝切换项目：

```json
{
  "mcpServers": {
    "supacloud-auto-link": {
      "command": "npx",
      "args": ["-y", "supacloud-mcp@latest", "--local"]
    }
  }
}
```

> 💡 读操作自动执行，写操作会弹出确认对话框——无需额外参数。

### 1.4 Multi-Server / Multi-Cluster Management

SupaCloud MCP natively supports multiplexing. If you have multiple servers (e.g. test environment, US East, Asia Pacific, etc.), **no code changes needed** - just register multiple commands of the same type in config with different environment variables:

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

After configuration, you can directly make targeted requests to AI: *"Check disk status for us-east, then install platform for ap-asia region"*, AI will automatically dispatch to corresponding environment processes for execution.

---

## 2. Usage Scenario Examples

You can directly make the following requests in the AI chat box, and AI will automatically call MCP tools to complete them.

### Scenario 1: Fresh Installation from Scratch
> **You**: "I just bought a server, IP is 1.2.3.4, please help me install SupaCloud, use domain `api.example.com`, set database password to `MySuperSecret!23`."
> 
> **AI**: Will sequentially call the following tools to complete installation:
> 1. `ping_server` → Verify SSH reachability
> 2. `setup_server_ssh` → Configure SSH self-connection (Pigsty/Ansible required) + fix OpenSSL compatibility
> 3. `install_supacloud` → Start installation in background (about 15-30 minutes)
>
> After installation starts, AI will return process PID. You can say anytime:
> **"Check installation progress for me"**, AI will call `ssh_exec` to execute `tail -f /tmp/supacloud-install.log`.
>
> ✅ **Note**: Installation runs in server background, won't interrupt even if you close the chat window. Use `diagnose_server` to verify service status after installation completes.

### Scenario 2: Daily Tenant Management
> **You**: "List all current Supabase projects for me, and create a new project named `app-prod`."
> 
> **AI**: (Sequentially calls `list_projects` and `create_project`) -> Tells you creation succeeded, with new project's Ref ID and database connection.

### Scenario 3: Auth and Advanced Features
> **You**: "Enable Google login for the `app-prod` project just created, here are my Client ID and Secret..."
> 
> **AI**: (Calls `update_auth_config`) -> Updates corresponding parameters.

### Scenario 4: Fast Schema Design with RLS (Using Composite Tools)
> **You**: "Create a table for user profiles in the `app-prod` project, make sure it is secure."
>
> **AI**: (Calls `create_table_with_rls` instead of `execute_sql`) -> Seamlessly executes `CREATE TABLE` and `ALTER TABLE ENABLE ROW LEVEL SECURITY` along with default permissive policies in a single operation.

---

## 3. Advanced MCP Native Features: Prompts & Resources

In modern AI assistants like Cursor and Claude Desktop, SupaCloud MCP provides deep IDE integration via Prompts and Resources.

### 3.1 Prompt Templates
You don't need to manually tell AI how to analyze your database. In your AI chat interface, click the **Prompts (Slash Menu)** to invoke these pre-loaded contexts:
- **`analyze_database_performance`**: Instantly instructs the AI to pull `get_database_stats` and `get_database_connections` and act as an expert DBA to hunt down slow queries, index bloating, and connection leaks for a specific project.
- **`design_tenant_schema`**: Prompts the AI to act as a Supabase Database Architect for a specific business domain. It's programmed to automatically cross-check existing schemas and *always* enforce UUID and RLS when generating new schemas.

### 3.2 Live Database Resources (Schema Files)
Instead of forcing the LLM to waste tokens sequentially searching tables via tools, the MCP server maps live Postgres schemas to virtual "files" that you or the AI can read instantly.
- **Resource URI Syntax**: `pg://{project_ref}/schema/{schema_name}` 
- **Example**: Mentally typing or explicitly attaching `pg://app-prod/schema/public` will automatically resolve into a dense Markdown documentation snapshot of every table and column in your public schema. The AI reads this instantly without burning API calls.

---

## 3. Installation and Operations Troubleshooting

During management of open source components or self-hosted PIGSTY + Supabase, you may occasionally encounter unexpected issues. We've designed built-in troubleshooting tools that allow AI to quickly locate problems.

### 3.1 Automatic Intelligent Diagnosis
If you find `install_supacloud` didn't run after installation, or got stuck midway due to network issues preventing API calls, just tell AI:
> **You**: "Installation seems to have failed, go troubleshoot the cause."
>
> **AI**: Will call `troubleshoot_install` tool. This tool automatically checks container and PostgreSQL survival status, disk space, and network port status, and returns a report like the following for diagnosis:
> `⚠️ Detected 1 potential issue: Container image pull abnormal, may be registry config error`

### 3.2 Extract Single Container Logs
If you find a specific service (like Analytics) keeps restarting (Exit 1), you can have AI fetch underlying information:
> **You**: "Get me the last 200 lines of error logs from the `supabase-analytics` container."
> 
> **AI**: (Calls `get_container_logs`, passing container="supabase-analytics", lines=200).

### 3.3 Manual Cleanup and Reinstall
For irreparable base environment issues diagnosed (like full disk or dirty data), you can have AI execute cleanup and re-diagnose after cleanup:
> **You**: "Server is too messy, help me execute `bash /tmp/setup.sh uninstall` then check disk space again."
> 
> **AI**: (Calls `ssh_exec` to uninstall, then calls `diagnose_server` to show new status).

### Common Environment Troubleshooting Reference
| Symptom | Troubleshooting Command/Tool Suggestion |
|---------|----------------------------------------|
| `install_supacloud` returns SSH connection failed | First call `ping_server`, then call `setup_server_ssh` to fix prerequisites |
| Pigsty/Ansible reports `Connection refused` | Call `setup_server_ssh` to fix SSH self-connection config |
| `setup.sh` download failed | Call `ssh_exec` to manually execute: `curl -fsSL https://ghproxy.net/...` |
| Web access stuck at Loading | Call `diagnose_server` to check if `Management API` process is healthy |
| Cannot create new tenants | May be Pigsty DNS drift, call `troubleshoot_install` |
| Function execution timeout | Call `get_container_logs` to check `supabase-edge-runtime` |
| Container image pull Error 403 | Call `troubleshoot_install` (focus='network') to query `docker.io` blocking and network restrictions |

---

## 4. 安全和最佳实践

### 4.1 分层安全模型

SupaCloud MCP 使用 MCP 协议原生的 `ToolAnnotations` 机制保障安全：

| 工具类型 | 注解 | 客户端行为 |
|---------|------|----------|
| 读操作（list_tables、describe_table 等） | `readOnlyHint: true` | ✅ 自动执行 |
| 写操作（execute_sql DDL/DML、deploy、delete 等） | `destructiveHint: true` | ⚠️ 弹窗确认 |

这意味着：
- AI 可以自由读取数据库结构和数据，提高工作效率
- 任何修改操作（INSERT、UPDATE、DROP 等）都需要用户明确确认
- 无需额外配置参数，安全内置于协议层

### 4.2 一般安全建议

1. **永远不要把包含 Master Token 的全局配置文件泄漏到公开代码仓库**：请作为本地秘密保留在 cursor 或 claude 配置中。
2. **谨慎使用 ssh_exec**：当 AI 建议使用 `ssh_exec` 执行破坏性操作（如 `rm -rf`）时，请仔细审查具体的 Command 参数后再确认。
3. **优先使用 Auto-Link 模式**：`service_role_key` 自动限定在单个项目范围，比 Master Token 更安全。
4. **为团队开发者使用 MCP Token**：通过 `create_mcp_token` 生成可过期、可只读的项目 Token。
