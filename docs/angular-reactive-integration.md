# Angular and RxJS integration / Angular 与 RxJS 集成

API examples: [official Angular integration](../packages/app/ANGULAR.md).
Framework-neutral defaults: [reactive development](./reactive-development.md).

## 提交关系

本批基于默认 RxJS PR #1556 的提交 c47eda534a6f7d8222ed3643636dfcdf1ef86c95。
保留其中的精确依赖版本、锁文件、SDK `/reactive`、脚手架与验证工具，
不覆盖原分支，不增加第二套 SDK `/rxjs`。旧本地补丁的 SDK 观察代码由已有实现替代。
先审查基础 PR，再审查本批 Angular 增量；合入 main 前须核对合并顺序和基线。

## 本批交付

- `@supacloud/app/angular` 复用 Angular 公共 Signals、Resource、DI 和 RxJS 互操作。
- `@supacloud/app/rxjs` 将订阅和官方 Signal 绑定到显式 SupaCloud 生命周期。
- 加固 DestroyRef 的异步释放、错误汇总和重复关闭，保持根入口公开声明。
- 增加原生 API 身份、作用域取消、资源释放与浏览器打包隔离测试。
- 文档通过 `@supacloud/js/reactive` 调用已有任务，不重新提交、重试或取消业务。

普通业务使用 async/await；事件组合使用 RxJS；Angular 展示状态使用官方 Signals。
Resource 参数变化只驱动读取。长连接必须有明确资源归属，不能借用已经关闭的请求事务。
旧 SupaCloud 同步 effect 的调度和返回值不同，本次不静默替换，也不引入 Zone.js。

## Task contract

Goal: official, isolated Angular reactive integration with explicit cleanup ownership.
Non-goals: framework replacement, SDK duplication, business-command changes, new CLI/MCP,
database migrations, CI or permission changes, automatic merge/publication/deployment.
Acceptance: upstream identity; cancellation and destruction safety; SDK reuse;
unchanged framework-neutral entrypoints; package/type/bundle verification.
Required review areas: TypeScript, Bun compatibility, provider adapters and lifecycle ownership.
Risk: cleanup failures remain observable; Angular runtime identity is externally resolved.
Rollback: revert this incremental commit; no data/schema migration or dependency upgrade.

11 dependency-free cleanup tests are locally runnable. The added Angular/RxJS and
bundle tests, full package typechecking and packed-consumer verification require
the actual repository toolchain. Do not treat the base PR's CI results as proof
that this incremental change passes. See the PR body for executed evidence.
