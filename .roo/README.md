# Roo Code Agent-Team 映射

本目录将 [`AGENTS.md`](../AGENTS.md) 与 [`.agents/`](../.agents) 中的 agent-team-config 约定桥接到 Roo Code。

## 已实现内容

- 项目级自定义模式配置：[`/.roomodes`](../.roomodes)
- 模式级规则目录：`/.roo/rules-<slug>/AGENTS.md`
- 现有仓库规则链继续生效：[`AGENTS.md`](../AGENTS.md)、[`.agents/prompts/`](../.agents/prompts)、[`.agents/workflows/`](../.agents/workflows)

## 角色 → Roo 模式映射

| agent-team 角色 | Roo 模式 slug | 说明 |
| --- | --- | --- |
| Architect | `agent-architect` | 只读诊断、架构建议、根因分析 |
| Executor | `agent-executor` | 实现、修复、验证闭环 |
| Verifier | `agent-verifier` | 基于证据做完成度裁决 |
| Planner | `agent-planner` | 任务拆解、范围澄清、验收标准 |
| Critic | `agent-critic` | 计划审查与执行前把关 |

## 工作流映射

| agent-team 工作流 | Roo 中的承载方式 |
| --- | --- |
| `/dev` | `agent-executor` 模式，附带 [`/.agents/workflows/dev.md`](../.agents/workflows/dev.md) 约束 |
| `/deep-review` | `agent-planner` / `agent-architect` 模式，附带 [`/.agents/workflows/deep-review.md`](../.agents/workflows/deep-review.md) 约束 |
| `/deploy-verify` | `agent-executor` / `agent-verifier` 模式，附带 [`/.agents/workflows/deploy-verify.md`](../.agents/workflows/deploy-verify.md) 清单 |
| `/db-migrate` | `agent-executor` 模式，附带 [`/.agents/workflows/db-migrate.md`](../.agents/workflows/db-migrate.md) 清单 |
| `/research` | `agent-architect` / `agent-planner` 模式，附带 [`/.agents/workflows/research.md`](../.agents/workflows/research.md) 指引 |
| `/handoff` | 任一模式收尾时参考 [`/.agents/workflows/handoff.md`](../.agents/workflows/handoff.md) |

## 状态与协作

- 持久化状态说明见 [`/.agents/state/README.md`](../.agents/state/README.md)
- 多 Agent 协调日志见 [`/progress.md`](../progress.md)
- 多 Agent 消息目录为 `/.mailbox/`

## 使用方式

1. 在 Roo Code 中刷新项目自定义模式。
2. 选择上述自定义模式之一。
3. Roo 会读取 [`/.roomodes`](../.roomodes) 中的角色定义，以及对应 `/.roo/rules-<slug>/AGENTS.md` 的模式附加规则。
4. 根级 [`AGENTS.md`](../AGENTS.md) 仍作为通用项目规则继续生效。
