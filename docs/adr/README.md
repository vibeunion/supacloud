# Architecture Decision Records / 架构决议

ADR 记录已选择的方向、责任边界与取舍；状态为 Approved 不代表全部代码、发布或生产验收已完成。
每份决议应记录事实核对基线、与旧规范的关系、实施台账、验收证据和回滚边界。

| 决议 | 状态 | 实施说明 |
| --- | --- | --- |
| [ADR-2026-10-02-ASYNC：异步编程模型、流边界与治理职责](2026-10-02-async-stream-governance.md) | Approved | 分阶段落实；本次仅固化规范，保留已有 SDK 与响应式入口 |
| [ADR-2026-11-23-RUST：Rust 平台能力引入与 PostgREST 边界](2026-11-23-rust-platform-adoption.md) | Approved | 第一阶段已实施；第 4 节已由 ADR-2026-11-24-DATA-PLANE 部分取代 |
| [ADR-2026-11-24-DATA-PLANE：统一 Data API，退役每项目 PostgREST 进程](2026-11-24-postgrest-dataplane-unification.md) | Approved | 第一阶段已实施（数据面进程 + 契约测试）；控制面切换与拆除未开始 |
| [Public GraphQL moves to Postrust Hasura](2026-11-24-postrust-graphql-public-cutover.md) | Accepted | Hosted `/graphql/v1` and Lite reads use the Hasura dialect. `/rest/v1/rpc/graphql` is 404. Not a production deploy. |
| [ADR-2026-11-25-REALTIME-CDC: Realtime consumes the tenant replication slot](2026-11-25-realtime-cdc-slot-consumption.md) | Accepted | The Rust gateway is the default Realtime server. It polls the `wal2json` slot through `realtime.list_changes` / `realtime.apply_rls`. `anon` and `authenticated` subscriptions are tenant rows. The NOTIFY path is removed. |
