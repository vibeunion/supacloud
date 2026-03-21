# Edge Runtime Guide

SupaCloud Edge Functions 从 v2.x 起默认使用 **Bun + Elysia Worker Thread Pool** 架构，替代原有的 Deno V8 Worker 方案。

## 为什么切换？

| | Deno (旧) | Bun (新) |
|--|----------|---------|
| 200 函数内存 | ~1.4GB | **~140MB** |
| 冷启动 | 40-60ms | 8-15ms |
| 用户函数改动 | — | **零改动** |
| 端口 | :9000 | :9000 (不变) |

## 架构

```
SupaCloud (:3000)             Edge Runtime (:9000)
├── Management API       ←──  Bun.spawn() 管理 + 崩溃自动重启
└── 仅监听 :3000              ├── Elysia Server
                              ├── Worker Thread Pool (4 线程, 固定 ~80MB)
                              ├── Deno 兼容层 (globalThis.Deno shim)
                              └── URL Import Plugin (deno.land/esm.sh → npm)
```

## 依赖管理

### Edge Runtime 自身依赖

`packages/edge-runtime/package.json` 中声明：

```json
{
  "dependencies": {
    "elysia": "^1.x"
  }
}
```

Elysia **只在 Runtime 服务层使用**，用户函数不强制依赖。

### 用户函数依赖

**用户函数可以使用任何框架或不用框架：**

```typescript
// 方式 A: 裸 handler（零依赖）
export default (req: Request) => new Response("hello");

// 方式 B: Elysia（推荐，性能最优）
import { Elysia } from "elysia";
export default new Elysia().get("/", () => "hello");

// 方式 C: 其他框架（Hono、itty-router 等）
import { Hono } from "hono";
const app = new Hono();
export default app;
```

### 自动依赖处理

| 来源 | 处理方式 | 需要手动安装？ |
|------|---------|-------------|
| `npm:xxx` | Bun 原生支持 | ❌ 自动 |
| `import "elysia"` | edge-runtime 已安装 | ❌ 自动 |
| `https://esm.sh/zod` | URL Plugin → 转为 `zod` | ⚠️ 需 `bun add zod` |
| `https://deno.land/std/...` | URL Plugin → 本地 shim | ❌ 自动 |
| 其他 npm 包 | node_modules | ⚠️ 需 `bun add xxx` |

> **注意**：用户函数中通过 `esm.sh` 引用的包，URL Plugin 会自动转成 npm 包名，但该包需要预先安装在 `packages/edge-runtime/node_modules` 中。部署流程应在函数上传时扫描 import 并自动安装缺失的包。

## 从 Deno 迁移

详细的迁移指南、完整代码实现和 API 映射表请参考：

- [实施文档 (完整版)](../packages/edge-runtime/IMPLEMENTATION.md)

**迁移步骤摘要**：

1. `./switch.sh runtime bun` — 切换运行时
2. 用户函数 **零改动** — Deno 兼容层 + URL Import Plugin 自动处理
3. `fetch("http://localhost:9000/...")` — 端口兼容，函数间调用不变
