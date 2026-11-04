# SupaCloud 框架性能对比方案

## 目标

每次 SupaCloud 核心版本发布后，在固定的 CI runner 上自动测量 SupaCloud
编译适配器与原生主流框架的 HTTP 开销，用于两件事：

1. 找出 SupaCloud 相对 Elysia 原生下界的额外开销，并定位优化方向；
2. 在相同请求契约、运行时和客户端下，给出 SupaCloud 与 Express、Fastify、
   NestJS/Express、NestJS/原生 Node 适配器的可复现对比。

“性能强”只能在同一场景、同一 runner、重复测量后成立。单次 CI 结果是
信号，不是生产容量承诺。

## 对比矩阵

| 路径 | 运行时 | 角色 |
| --- | --- | --- |
| SupaCloud compiled adapter | Bun + Elysia 2 | 主结论对象 |
| Express | Node 24 | 原生对手 |
| Fastify | Node 24 | 原生对手 |
| NestJS + Express | Node 24 | 原生对手 |
| NestJS + `@nestjs/platform-node` | Node 24 | 原生对手 |
| Elysia 2 native + 同等契约 | Bun | SupaCloud 适配器的内部基线 |
| Elysia 2 native bare | Bun | 纯传输下界，不作为产品对手 |

SupaCloud 路径加载发布 tag 对应的本地 `@supacloud/elysia`，并重新构建
其 `contracts → delivery → commands → db → compiler → app → elysia` 依赖链，
避免把工作区残留的 `dist` 当作版本证据。

## 请求场景与指标

每个适配器独立子进程、同一个 Node 原生 `fetch` 客户端、loopback 地址、同一
并发数、warmup 和旋转后的场景顺序：

- `GET /json`：路由和 JSON 响应基线；
- `GET /params/benchmark`：路径参数匹配和响应序列化；
- `POST /echo`：JSON body 解析、输入契约和响应序列化。

contract 基线要求所有路径校验同一组 TypeBox 语义：Elysia/SupaCloud 使用原生
route schema，Fastify 使用 JSON Schema/Ajv，Express 和 Nest 使用 TypeBox
middleware/pipe。若未来某个框架确实无法接入 TypeBox，Zod 只能作为单独标记的
validator 行，不能和 TypeBox 结果混成一个结论。

报告记录每轮 RPS、P50/P95/P99、错误数、运行时和依赖版本。汇总使用轮次中位数，
不把不同场景或不同 runner 混成一个总分。任何响应错误都会让 CI 失败。

默认且唯一的 SupaCloud 路径使用编译器生成的 positional `invoker`。生产运行时
不再保留旧的 input-object 兼容调用路径，避免 benchmark 和正式运行时出现两套
性能与行为边界。

`createSupaCloudFramework` 已默认要求生成的 invoker；底层 `createApplication`
仍允许手写测试模块显式使用 fallback，以便完成渐进迁移。正式编译产物不应依赖
该 fallback。

默认请求带有 Edge Runtime 提供的 `x-request-id`；使用
`--request-id-mode generated` 才会测量缺少请求 ID 时的 UUID fallback 成本。

## CI 与发布触发

`.github/workflows/framework-comparison.yml` 监听 GitHub Release `published`，
对 `elysia-v*`、`app-v*`、`compiler-v*` 和 `supacloud-v*` 标签运行；也支持手工
传入 ref、请求数、轮数和并发数。结果同时写入 Job Summary，并上传 JSON/Markdown
artifact。基线比较初期不自动阻断发布，先积累同 runner 的稳定样本，再引入阈值。

## 优化闭环

先看 SupaCloud 与 native Elysia 的差距，再看 SupaCloud 与四个原生对手的相对位置。
如果差距集中在所有场景，优先检查插件注册、请求上下文、scope 查找和统一响应路径；
如果只出现在 body 或 params，分别检查 schema decoder、解析和参数转换；如果只有
P99 变差，检查 GC、日志和 after-response 生命周期。每次优化都要保留相同版本矩阵
和至少 5 轮结果，避免用一次低负载抖动得出结论。

## 验收准则

```gherkin
场景: 核心版本发布后自动运行对比
  假设 一个 elysia-v、app-v、compiler-v 或 supacloud-v Release 已 published
  当 GitHub Actions 启动 framework-comparison
  那么 workflow checkout 该 Release tag，构建 SupaCloud 适配器并运行全部适配器

场景: 所有框架使用同一请求契约
  假设 benchmark 已启动五条产品路径和一条 native Elysia 下界路径
  当 runner 执行 static-json、path-params 和 json-body
  那么每条路径都使用相同的请求、响应字段、客户端、warmup 和并发配置

场景: 响应契约失败阻断结果
  假设任一适配器返回非预期状态码或 JSON
  当该轮测量结束
  那么 runner 以非零状态退出，并且报告显示错误数量

场景: 报告可复核
  假设所有轮次没有错误
  当 benchmark 完成
  那么 Job Summary 和 artifact 同时包含配置、commit/tag、运行时、依赖版本和 P50/P95/P99/RPS
```
