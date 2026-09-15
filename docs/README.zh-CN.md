# SupaCloud 文档中心

[English](./README.md) | [简体中文](./README.zh-CN.md)

## 快速链接

- [CLI 使用指南](./cli-guide.md) - 用户 CLI 与管理员 CLI 入口职责边界
- [项目端点投射](./project-endpoint-projection.md) - 权威 API/Auth/Studio 源站与项目/Admin 读取边界
- [部署指南](./deploy-guide.md) - 完整部署使用指南
- [部署 API](./deploy-api.md) - 自动化部署 API 参考
- [配置文件示例](./supacloud.yml.example) - 部署与运行配置文件示例
- [SupaCloud 与 Supabase 对比](./supacloud-vs-supabase.md) - 产品定位与核心特性差异对比
- [数据库环境晋级](./database-environment-promotion.md) - 本地、预览、Staging 与生产环境迁移流

## 架构设计

- [多租户架构设计](./architecture-multi-tenant.md) - 共享底座多租户隔离架构
- [多租户管理契约](./multi-tenant-management.md) - Management API 规范、鉴权边界与运维加固
- [企业级架构就绪度](./enterprise-architecture-readiness.zh-CN.md) - 基础设施边界、SLO 模型、灾备验收与发布治理 ([English](./enterprise-architecture-readiness.md))

## 部署与托管

- [部署指南](./deploy-guide.md) - 完整自动化部署指南
- [部署 API](./deploy-api.md) - 部署管理 API 规范文档
- [CI/CD 集成](./ci-cd-integration.md) - 基于 GitHub Webhook 的持续集成与自动部署
- [前端静态托管](./frontend-hosting.md) - SupaCloud Pages 静态站点托管与原子发布
- [发布控制自动化与灰度规范](./release-control-automation-spec.md) - Headless PKCE Canary、批量云函数发布与 CAS 回滚契约

## 认证体系

- [OAuth 提供商配置](./oauth-providers.md) - 常用 OAuth Provider 配置
- [OAuth 2.1 / OIDC 服务端](./oauth-oidc-provider.md) - 项目级 OAuth 服务端迁移、Discovery、JWKS 与客户端管理
- [GoTrue v2.193 升级基线](./gotrue-v2.193-upgrade.md) - 历史 Checksum、增量迁移回读、MFA 验收与回滚边界
- [国内 OAuth 集成](./china-oauth-integration.md) - 微信、支付宝、钉钉第三方登录集成
- [微信登录集成](./wechat-auth-integration.md) - 微信开放平台、公众号与小程序登录方案

## 运维治理

- [CLI 使用指南](./cli-guide.md) - `@supacloud/cli` 与 `@supacloud/admin`
- [可选 AI 运维 MCP 服务](./mcp-ai-operations.zh-CN.md) - Streamable HTTP MCP 协议、工具集、资源与计划策略 ([English](./mcp-ai-operations.md))
- [AI 运维 MCP 测试需求](./mcp-ai-operations-test-requirements.md) - 协议、鉴权、隔离与测试验收规范 ([English](./mcp-ai-operations-test-requirements.en.md))
- [Pigsty 备份与恢复运维](./pigsty-backup-operations.zh-CN.md) - pgBackRest 清单校验、PITR 计划与恢复演练 ([English](./pigsty-backup-operations.md))
- [可观测性与日志基线](./observability.md) - VictoriaLogs + 内置采集器基线、Prometheus 指标与 SLO 定义 ([English](./observability.en.md))
- [项目端点投射](./project-endpoint-projection.md) - 固定端点 Schema、命令与就绪限制
- [PostgREST 运行时生命周期](./postgrest-runtime-lifecycle.md) - 组件级期望状态配置、暂停/恢复/状态对齐
- [pgredis 运行时](./pgredis-runtime.md) - 私有缓存数据面、控制面 API、Web Console 运维与安全边界
- [平台组件升级说明](./platform-component-upgrade-notes.md) - 破坏性变更、迁移步骤、可选特性与回滚说明
- [升级至 Pigsty 4.5](./upgrade-to-pigsty-4.5.md) - 当前 Pigsty 版本锁定与升级验证
- [Pigsty 4.4 兼容性迁移历史](./upgrade-to-pigsty-4.4.md) - 分析组件与 Supabase 兼容迁移背景
- [Docker PostgreSQL 4.4 升级](./upgrade-postgres-docker-4.4.md) - Docker 容器化兼容性、备份与大版本安全指南
- [Podman DNS 故障排查](./troubleshooting-podman-dns.md) - Podman 容器内 DNS 解析问题定位与修复

## 开发框架与运行时

- [Edge Runtime 指南](./edge-runtime-guide.md) - Bun + Elysia Worker 线程池云函数运行时架构
- [后台异步云函数](./background-functions.md) - 异步函数任务执行、状态轮询、重试与死信队列（DLQ）
- [基于 supabase-js 的后台函数教程](./background-functions-supabase-js-tutorial.md) - 租户 SDK 调用、轮询、取消、DLQ、生命周期 Webhook 与队列
- [后台函数 API 参考](./background-functions-api-reference.md) - 请求头规范、任务状态机、控制面板端点与语义
- [@supacloud/js](./supacloud-js.md) - 基于 `supabase-js` 的官方平台 SDK，增强后台任务、Webhook 与队列
- [Queues PGMQ 迁移指南](./queues-pgmq-migration.md) - Supabase Queues 兼容性与 SupaCloud 队列扩展迁移
- [持久化工作流](./durable-workflows.md) - Service-role 专用的 PostgreSQL/PGMQ 工作流与 DBOS 架构决策
- [业务状态机](./business-state-machines.md) - Maker-Checker 状态流转 RPC、审计留痕与 XState 投射
- [PowerSync 离线优先同步](./powersync-local-first.md) - 私有化同步边界、复制就绪度、RLS 写入流与冲突处理
- [应用架构指南](./application-architecture.md) - 可扩展 Monorepo 规范、迁移治理与契约边界
- [应用开发框架](./application-framework.md) - Angular 风格模块与依赖注入、编译期无反射代码生成与 Elysia 运行时
- [路由契约升级迁移](./route-contract-migration.md) - schema-first 路由、客户端 decoder、OpenAPI 与 Management API 注册表迁移
- [数据库治理](./database-governance.md) - RLS/RPC 作为一等资源管理、Catalog 对齐与 SQL Lint (`@supacloud/db`)
- [应用平台原语](./application-platform-primitives.md) - 自定义 PostgREST Schema、事务性 Command 回执与不可变物料追溯

## 产品定位

- [SupaCloud 与 Supabase 对比](./supacloud-vs-supabase.md) - 何时选择 SupaCloud、Supabase Cloud 或官方自建 Supabase
