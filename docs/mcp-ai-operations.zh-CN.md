# 可选 AI 运维 MCP 服务

[English](mcp-ai-operations.md) | [简体中文](mcp-ai-operations.zh-CN.md)

SupaCloud 通过 Streamable HTTP MCP 协议提供可选的、面向客户的 AI 运维接口。除非客户显式连接 MCP 客户端并提供现有的 SupaCloud 管理员或项目级凭据，否则该能力作为产品特性默认处于关闭状态。

## 协议契约

- 平台管理员端点：`POST /mcp`。
- 项目级客户端端点：`POST /mcp/projects/{project_ref}`。
- 只读 Developer MCP 端点：`POST /mcp/developer/projects/{project_ref}`（仅提供应用开发契约）。
- 协议版本：`2025-06-18`。
- 传输格式：基于 `application/json` 的 JSON-RPC 2.0。
- 状态模型：完全无状态。SupaCloud 不返回 `Mcp-Session-Id`，不维护会话映射表，也不保存大模型的对话状态。
- 认证机制：复用既有的 `Authorization: Bearer ...` 管理员/项目 Token 鉴权。
- 响应缓存：通过 `Cache-Control: no-store` 禁用响应缓存。
- 写入策略：仅生成计划（plan-only）。大模型无法通过 MCP 执行 Shell 命令、获取数据库密码或直接发起数据恢复。

客户端在完成初始化握手后，后续请求应携带 `MCP-Protocol-Version` 头。服务端在响应中返回相同的协议版本。`notifications/initialized` 请求会收到 HTTP 202 与空响应体。

## Developer MCP 接口

Developer MCP 是独立、项目限域、只读的接口，仅暴露 `supacloud.get_capabilities` 与 `supacloud.get_application_development`，返回 `write_policy: "read_only"`，且不列出备份或指标资源。它不替代仅生成计划的运维接口，运维端点也不暴露开发工具。两种接口消费同一份 `supacloud.application-development.v1` 契约，确保 AI 与应用开发者控制台不会出现数据漂移。

`supacloud.get_application_development` 读取一个不可变的应用 release target，返回经过校验的开发契约（模块、路由、资源、资源使用、执行计划与诊断信息），并附带 `correlation: "verified-build-snapshot"`。字节来自 `ApplicationReleaseStorage` 已完成哈希校验的 release 归档，因此结果是构建证据，而非对当前源码的重新推断。

## 工具列表

### `supacloud.get_capabilities`

返回机器可读的 AI 运维契约，包括作用域（scopes）、可用工具、资源 URI、无状态行为及仅计划写入策略。

### `supacloud.get_backup_readiness`

从配置的 Pigsty/pgBackRest 清单（inventory）读取项目备份就绪证据：

- stanza 与 PITR 配置状态；
- 已完成且可读的备份数量；
- 最新一次已完成的备份信息；
- 就绪状态（status）。

该工具直接校验 pgBackRest 的权威清单状态，绝不根据 Shell 执行退出码推测备份成功与否。

### `supacloud.get_request_metrics`

返回当前 Management API 的 Prometheus 文本格式指标，包括请求数、错误计数和 HTTP 状态分布。这些指标仅限进程本地，应与外部监控系统的持久化存储相结合进行故障历史分析。

### `supacloud.plan_pitr_restore`

为指定的 RFC3339 UTC 时间戳生成非执行状态的 PITR 恢复计划。该计划会记录项目、目标时间、前置条件、审批要求及确认字符串。实际执行仍必须通过既有的备份 API 流程、双人审核（maker-checker）审批、幂等控制、审计日志、操作回执以及恢复后健康验证。

### `supacloud.get_application_development`（仅 Developer MCP）

仅在 `POST /mcp/developer/projects/{project_ref}` 提供。读取一个不可变应用 release target 的、经过校验的 `supacloud.application-development.v1` 契约。入参为 `application_id`、`release_id` 与 `target`。结果是只读构建证据，绝不执行应用代码。

## 资源列表

- `supacloud://capabilities`
- `supacloud://project/{project_ref}/backups`
- `supacloud://project/{project_ref}/metrics`

项目级凭据只能读取其所属项目的资源。平台管理员可以使用平台端点，并在工具 Schema 允许的入参中显式传入 `project_ref`。

## 调用示例

```http
POST /mcp/projects/demo-project
Authorization: Bearer <existing-project-or-admin-token>
Content-Type: application/json
MCP-Protocol-Version: 2025-06-18
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "supacloud.plan_pitr_restore",
    "arguments": {
      "target": "2026-09-07T00:00:00Z"
    }
  }
}
```

## 客户接入要求

接入 AI 客户端时应遵循以下规范：

1. MCP 连接应显式启用并限定在租户作用域内。
2. 将工具返回的数据视为客观证据，而非执行状态变更的授权。
3. 展示返回的计划，并在调用现有写入 API 之前必须经过人工确认审批。
4. 在整个审批与执行工作流中持久化操作回执（operation receipt）、trace ID、correlation ID 及审计事件。
5. 在 Prompt、日志、工具输出和导出的链路追踪中，对 Bearer Token、数据库 URL、密码、Service Role Key 和 Provider 凭据进行严格脱敏。
6. 仅重试幂等读取操作。长时间运行的写入操作必须通过既有的操作状态与回执 API 轮询，不得依赖 MCP 会话状态。

Pigsty/pgBackRest 备份底层配置属于基础设施职责。MCP 仅暴露其经过验证的清单与计划入参，并不替代 Pigsty、pgBackRest、备份保留策略、异地副本同步或恢复演练。
