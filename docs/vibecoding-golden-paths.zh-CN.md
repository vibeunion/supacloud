# Vibecoding 黄金路径

[English](vibecoding-golden-paths.md) | [简体中文](vibecoding-golden-paths.zh-CN.md)

状态：目标工程体验，不代表已完成。
已实施的改动及其验证边界见[本地验收记录](vibecoding-acceptance.md)。

## 目标

SupaCloud 借鉴 Angular 的**工程体验**——单一入口、强约定、生成器、编译期反馈与可执行诊断——但不照搬 NgModule、装饰器体系或包体量。运行时与平台能力保持 SupaCloud 原生。

> Angular 参考的是工程体验，不是技术实现；目标是让 Vibecoding 变成一条有约束、可诊断、可交付的开发流水线。

## 快速开始

```bash
supacloud app init --name orders-api --template http   # 或 command / edge
cd orders-api && bun install && bun run check

supacloud context --format json > context.json   # AI 读取已编译的项目图
supacloud doctor --format json > doctor.json     # 可执行诊断 + 修复计划
supacloud fix --fix fix.json --write             # 应用一个 DiagnosticFix 后复检
```

## 单一入口

开发者与 AI 只面对一套 CLI，不需要记住底层包：

```bash
supacloud app init
supacloud dev
supacloud generate ...
supacloud check
supacloud context --format json
supacloud doctor
supacloud fix --fix fix.json   # 默认预览，--write 落盘
supacloud deploy
```

`app` 命名空间作为底层形式保留（`supacloud app <verb>`），顶层动词是同一实现与执行策略的别名。

> 生成项目中的本地开发循环是 `bun run dev`（watch、编译、重启）；
> `supacloud dev ...` 是独立的远程项目 sync/watch/migrate 模块，二者不同。

## 强约定项目结构

目标是固定、AI 易读的布局，让 Agent 不必扫描仓库即可定位入口、业务模块、生成文件与受保护文件：

```text
src/
  app/        # 应用入口与装配（受保护）
  modules/    # 业务模块（feature slice）
  shared/     # token、跨模块契约与工具
generated/    # 编译器产物（不要手改；会做漂移校验）
supacloud.config.ts
```

当前脚手架入口是 `src/application.ts`，业务模块按模板位于 `src/review/`、`src/orders/` 或 `src/sync/`。生成器默认使用 `src/features/`，可通过 `--dir` 指定其他模块目录。上面的布局是目标，不代表当前生成目录，也不要求已有项目迁移。

## 生成器优先

常见任务都有稳定、可重复的生成器，产物可读、可改、可重复生成，不是黑盒：

```bash
supacloud generate --kind module   --name orders
supacloud generate --kind controller --module orders
supacloud generate --kind command  --module orders --name accept
supacloud generate --kind query    --module orders --name list
supacloud generate --kind job      --module orders --name sync-orders
supacloud generate --kind contract --module orders --name accept
```

## 编译器替开发者做更多判断

编译器提前报告可静态证明的错误：模块依赖、Scope 误用、路由/Schema 不一致、Command 缺少权限/事务/幂等、生成文件漂移、非法跨层引用、Provider 能力未配置。

## AI 专用上下文

`supacloud context --format json` 输出已编译的模块图、Provider、路由/Command/Job、诊断与建议命令。`--target <name>` 支持模块名/类名，以及模块拥有的 Provider、Controller、Command、Job 和 Query 名称；结果仍以所属模块的邻域为边界，`subject` 保持规范模块名，版本 1 数据结构不变。存在多个所属模块时会报歧义，要求显式指定模块。AI 读结构化上下文，不接触凭据或真实用户数据。

## 三条黄金路径

先保证少数几条路径稳定，每条都有模板、生成器、示例、测试与部署流程：

1. **HTTP API**：控制器、路由契约与请求/响应校验。
2. **数据库事务与 Command**：持久化授权、幂等、事务与审计。
3. **Worker / Edge**：后台任务与边缘函数的明确治理边界。

不要一开始支持所有组合，也不要为每个能力新增包。

## 诊断必须可执行

`doctor` 返回稳定错误码、文件位置、原因、修复建议、完整 `fix` 数据与默认预览命令。每个 `fixPlan` 条目包含 `readiness` 和 `reason`：

- `preview`：执行器支持，且所需策略输入已明确。
- `input-required`：仍需提供权限、策略值或具体模块导入。
- `manual`：执行器尚不支持该语义修改。

`autoFixable` 仅统计可预览条目；`inputRequired` 和 `manualFixes` 分别统计其余建议。可预览不代表通过 AST 校验、获得写入授权或业务正确；不会自动推断权限或降低策略要求。

```bash
supacloud context --format json > context.json
supacloud doctor --format json > doctor.json
supacloud fix --fix fix.json          # 预览
supacloud fix --fix fix.json --write  # 应用
```

## 共享 Command 装配

`@supacloud/elysia` 提供可选的 `bindCompiledCommand`：模块、Command 类名、治理适配器、处理函数和结果解码器只配置一次；HTTP、Worker 和可信服务端调用逐次传入输入、Request、已验证身份与 scope。

它委托现有直接执行/预览 API，不替换路由绑定、不添加队列引擎，也不把业务策略移出所属模块。显式传入 `preview` 函数时，返回类型保证可直接调用预览；动态可选配置仍需先判断。示例见 [运行时文档](../packages/elysia/README.md#bind-a-command-once)。

同一操作不要同时使用路由 Command 绑定和内部直接绑定调用，避免重复治理。长生命周期绑定不要捕获请求级服务；输入校验、Worker 宿主身份验证仍须显式完成。内存适配器测试不证明真实数据库原子性。

## 兼容与发布

上下文与修复计划增量不改变现有运行时 DI、权限、事务、队列、前端传输或部署拓扑。Command 绑定是额外的便捷入口，原有 API 保留。

CLI 在仓库开发时依赖本地 compiler，确保测试覆盖配套实现。发布时须通过现有 `sync-compiler-dependency.mjs` 将本地引用转换为已发布版本范围。本地构建通过不等于 npm 已发布或生产验收通过。

## 不建议做的事

- 不照搬 Angular 的 NgModule 与装饰器体系。
- 不为显得完整而增加大量包。
- 不创建包含所有运行时能力的巨型包。
- 不让 AI 依赖隐式约定或内部 API。
- 不同时维护多套 Schema、权限与迁移规则。
