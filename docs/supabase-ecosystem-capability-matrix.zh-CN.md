# Supabase 生态能力矩阵

这份矩阵回答一个容易混淆的问题：SupaCloud 已经拥有多少 Supabase 能力，哪些只是安装了
PostgreSQL 扩展，哪些已经成为可运维的项目能力。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 已具备 | 有项目级 API、运行时实现、权限边界和针对性验证。 |
| 部分具备 | 底层包或兼容层已存在，但缺少产品入口、治理、恢复验证或完整文档。 |
| 待补齐 | 当前没有稳定的 SupaCloud 契约；引入前应先完成设计和验收。 |

## 当前矩阵

| 能力 | 状态 | 当前实现 | 剩余工作 |
| --- | --- | --- | --- |
| PostgreSQL 扩展安装与项目启停 | 已具备 | `packages/management-api/src/routes/extensions.ts`、`extension.service.ts`、`extension-policy.ts`；使用 `RESTRICT` 删除并区分系统包和项目扩展；目录返回 `capability`，包含预加载、迁移、备份、RLS、资源和回滚契约。 | 仍需在目标 PostgreSQL/Pigsty 版本上完成真实启停、备份恢复和升级兼容性验收。 |
| PGMQ / Supabase Queues | 已具备 | `pgmq_public` 官方兼容 RPC、队列管理扩展、幂等入队、可见性超时、队列指标和 SDK。见 `docs/queues-pgmq-migration.md`。 | 继续把死信、重放和消费者幂等要求落实到控制台和运行手册；不要再引入第二套队列。 |
| 后台任务与 Durable Workflows | 已具备 | PGMQ、Worker、Workflow RPC、租约、重试、幂等回执和任务查询均已有实现。 | 只补具体业务需要的执行器和验收，不新建通用工作流引擎。 |
| 定时任务 / Cron | 已具备 | 全量平台使用 `scheduled_functions`、`scheduled_jobs` 投影和 run ledger；Lite 提供 `pg_cron` 兼容服务。 | 保持“跨项目函数调度”和“数据库本地 SQL cron”两条边界，并完善时区、补跑和多实例验收。 |
| `pg_net` / Webhooks | 已具备 | Outbox、Webhook delivery worker、网络限制和 Lite `NetService` 已存在。 | 增加按项目的出站域名、并发、超时和费用预算可观测性。 |
| Realtime | 已具备 | 项目数据面包含 Realtime；有自动附加触发器、通知 payload 和任务进度回退路径。 | 继续以 outbox/任务状态为事实源，Realtime 只作为通知通道。 |
| `pg_graphql` | 已具备 | `pg_graphql` 可选启用；启用时会修复 `graphql_public` 入口、角色权限和 PostgREST schema reload。见 `docs/graphql-project-enablement.md`。 | 保持可选；补充查询深度/复杂度预算和持久化查询策略，不迁移业务写入真相源。 |
| `pgvector` 基础能力 | 部分具备 | PostgreSQL 镜像安装并初始化 `vector`；CLI 有向量列和 HNSW 示例。 | 提供正式的项目模板、维度/索引限制、RLS 安全的匹配 RPC、迁移检查和基准验收。 |
| 向量 + 全文混合检索 | 部分具备 | `storage-vector.service.ts` 是 Storage Vectors 兼容的 exact-scan 数据面；`docs/pgvector-hybrid-search.md` 新增了 `pgvector` + `tsvector`/GIN + `pg_trgm` + RRF starter。 | 仍需由具体项目落迁移、接入 Embedding Worker，并完成 RLS、陈旧任务和目标数据量基准验收。 |
| AI 模型与 Edge Functions | 部分具备 | Edge Functions、后台任务、Supabase JS 兼容入口和 `/v1/chat/completions` 代理已有；代理现在写入管理员可读的 AI 用量/成本账本。 | 流式响应仍只能记录请求级用量，模型提供方适配器、精确流式 token 统计和敏感输入脱敏仍需按业务接入。 |
| PostGIS | 部分具备 | 镜像安装并初始化 PostGIS。 | 只有在市场、客户、物流或 PCB 空间查询有实际需求时，才补空间类型、索引、RLS 模板和地理查询基准。 |
| Vault / `pgsodium` | 部分具备 | Vault 和 `pgsodium` 包及 fail-closed key loader 已存在，默认关闭，配置见 `docker/self-host/.env.example`。 | 以 Vault 加外部密钥管理为正式路径，补轮换、备份恢复和密钥丢失演练；不要围绕待弃用的 `pgsodium` 建新的业务 API。 |
| Foreign Data Wrappers | 部分具备 | `wrappers` 包已安装；Wrappers 路由支持 Vault 引用、状态读取、凭据轮换和 `DROP SERVER ... RESTRICT` 删除，并且不会返回明文凭据。 | 仍需将出站网络白名单、默认只读、超时/行数限制和跨租户数据隔离落实到真实 FDW/网络策略并验收。 |
| `pg_jsonschema` | 已具备 | 镜像初始化并使用于数据库契约和输入约束。 | 只在业务 schema 需要 JSON 校验时启用，保留迁移版本和错误码契约。 |
| `pgTAP` / `plpgsql_check` / `hypopg` / `index_advisor` | 部分具备 | 依赖已安装，可用于数据库测试、PL/pgSQL 检查和索引评估。 | 接入迁移 CI 和项目验收命令；不能把静态检查结果当成真实 PostgreSQL/S3/Realtime 验收。 |
| Supabase CLI / 迁移 / 类型生成 | 部分具备 | SupaCloud CLI 支持数据库查询、迁移 dry-run、扩展和 `@supabase/supabase-js` 兼容工作流。 | 补齐本地、预览、测试、生产环境的 migration/seed/types 证据链，并保持发布和恢复边界清晰。 |
| Branching / 应用级 Preview | 部分具备 | 数据库分支已有创建、晋级、删除、TTL 自动清理；分支 API 支持 `application_id`、`release_id`、`environment_id`、`expires_at` 和 cleanup policy，并在没有安全资源删除器时保留 `cleanup_pending` 审计状态。 | 应用发布包、队列、对象存储、Secret、路由和外部服务仍需绑定到同一 Preview 生命周期；当前不会假装自动删除这些资源。 |
| TanStack DB / Local-first 同步 | 待补齐 | 当前没有稳定的 SupaCloud 同步契约。 | 仅在明确需要离线编辑时评估；先解决冲突、RLS、删除传播和恢复语义。 |

## 推荐补齐顺序

1. **扩展真实验收**：目录契约已补齐；下一步在目标 PostgreSQL/Pigsty 版本执行启停、备份恢复和升级回滚。
2. **pgvector 项目接入**：starter 已补齐；下一步由项目落迁移、接入 Embedding Worker，并完成小数据集正确性、权限和规模基准验收。
3. **AI 运行账本增强**：基础账本已接入聊天代理；下一步按模型供应商补充流式 token、价格版本和敏感输入脱敏，敏感输入只保存哈希或脱敏摘要。
4. **Wrappers/Vault 治理**：把外部数据源和密钥引用纳入项目级网络策略、审计和恢复演练。
5. **分支环境**：最后再实现完整 Branching；它会同时影响 PostgreSQL、Storage、Auth、Realtime、
   Functions、域名和费用配额。

## 不应重复建设

- 不再引入第二套 Redis、Kafka 或通用工作流引擎；PGMQ、Worker 和 Durable Workflows 已经是平台
  的异步执行边界。
- 不把 GraphQL、PostgREST 和业务 RPC 变成多个写入真相源。
- 不先引入 `pg_search`、ParadeDB 或 VectorChord；只有在原生混合检索基准不足且完成许可证、升级
  和恢复评估后才考虑。
- 不把浏览器直接连接到私有 pgredis、数据库或服务角色；项目权限仍由 JWT、grants、RLS 和受信任
  的 RPC/Worker 共同约束。
