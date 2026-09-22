# Vibecoding 黄金路径

[English](vibecoding-golden-paths.md) | [简体中文](vibecoding-golden-paths.zh-CN.md)

状态：目标工程体验，不代表已完成。

## 目标

SupaCloud 借鉴 Angular 的**工程体验**——单一入口、强约定、生成器、编译期反馈与可执行诊断——但不照搬 NgModule、装饰器体系或包体量。运行时与平台能力保持 SupaCloud 原生。

> Angular 参考的是工程体验，不是技术实现；目标是让 Vibecoding 变成一条有约束、可诊断、可交付的开发流水线。

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

新项目使用固定、AI 易读的布局，让 Agent 不必扫描仓库即可定位入口、业务模块、生成文件与受保护文件：

```text
src/
  app/        # 应用入口与装配（受保护）
  modules/    # 业务模块（feature slice）
  shared/     # token、跨模块契约与工具
generated/    # 编译器产物（不要手改；会做漂移校验）
supacloud.config.ts
```

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

`supacloud context --format json` 输出已编译的模块图、Provider、路由/Command/Job、诊断与建议命令；`--target <module>` 缩小到单个模块邻域。AI 读结构化上下文，不扫描仓库，也不接触凭据或真实用户数据。

## 三条黄金路径

先保证少数几条路径稳定，每条都有模板、生成器、示例、测试与部署流程：

1. **HTTP API**：控制器、路由契约与请求/响应校验。
2. **数据库事务与 Command**：持久化授权、幂等、事务与审计。
3. **Worker / Edge**：后台任务与边缘函数的明确治理边界。

不要一开始支持所有组合，也不要为每个能力新增包。

## 诊断必须可执行

`doctor` 不只报告“失败”，而是返回稳定错误码、文件位置、原因、修复建议、是否可自动修复，以及对应命令。

```bash
supacloud context --format json > context.json
supacloud doctor --format json > doctor.json
supacloud fix --fix fix.json          # 预览
supacloud fix --fix fix.json --write  # 应用
```

## 不建议做的事

- 不照搬 Angular 的 NgModule 与装饰器体系。
- 不为显得完整而增加大量包。
- 不创建包含所有运行时能力的巨型包。
- 不让 AI 依赖隐式约定或内部 API。
- 不同时维护多套 Schema、权限与迁移规则。