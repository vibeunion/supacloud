# Edge Runtime Guide

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## English

SupaCloud Edge Functions uses **Bun + Elysia Worker Thread Pool** as the recommended runtime, replacing the legacy Deno V8 Worker approach.

### Why Switch?

| | Deno (legacy) | Bun (new) |
|--|----------|---------|
| Memory (200 functions) | ~1.4GB | **~140MB** |
| Cold start | 40-60ms | 8-15ms |
| User code changes | — | **Zero** |
| Port | :9000 | :9000 (unchanged) |

### Architecture

```
SupaCloud (:3000)             Edge Runtime (:9000)
├── Management API       ←──  Bun.spawn() + auto-restart on crash
└── only listens :3000        ├── Elysia Server
                              ├── Worker Thread Pool (4 threads, fixed ~80MB)
                              ├── Deno Compat Shim (globalThis.Deno)
                              └── URL Import Plugin (deno.land/esm.sh → npm)

Kong/Angie Gateway:
  /api/*        → :3000 (Management API)
  /functions/*  → :9000 (Edge Runtime, direct)
```

### Dependency Management

**Edge Runtime dependencies** (Elysia etc.) are declared in `packages/edge-runtime/package.json`.

**User function dependencies** are auto-scanned during deployment:
- `npm:xxx` — Bun native support ✅
- `https://esm.sh/xxx` — URL Plugin converts to npm package, auto-installed ✅
- `https://deno.land/std/...` — Mapped to local shims ✅
- Other npm imports — Auto-scanned and installed ✅

Users can use **any framework or none**:

```typescript
// Option A: Bare handler (zero deps)
export default (req: Request) => new Response("hello");

// Option B: Elysia (recommended, best performance)
import { Elysia } from "elysia";
export default new Elysia().get("/", () => "hello");

// Option C: Any framework (Hono, itty-router, etc.)
import { Hono } from "hono";
export default new Hono().get("/", (c) => c.text("hello"));
```

### Migration from Deno

**Step 1**: Switch runtime
```bash
./switch.sh runtime bun
```

**Step 2**: Deploy functions — **zero code changes required**
- `Deno.env.get()` → handled by Deno compat shim
- `https://deno.land/std/...` imports → handled by URL Import Plugin
- `https://esm.sh/...` imports → auto-converted to npm packages
- `fetch("http://localhost:9000/...")` → port unchanged, works as-is

**Step 3**: Verify
```bash
curl http://localhost:9000/health
curl http://localhost:9000/functions/v1/your-function
```

### API Mapping (Deno → Bun)

| Deno API | Bun Equivalent |
|----------|---------------|
| `Deno.serve()` | `Elysia().listen()` (runtime handles this) |
| `Deno.readTextFile(path)` | `Bun.file(path).text()` |
| `Deno.env.get(key)` | `process.env[key]` |
| `Deno.stat(path)` | `fs/promises.stat()` |
| `new Worker(url, { deno: { permissions } })` | `new Worker(path)` |
| `import "https://esm.sh/xxx"` | `import "xxx"` (auto) |
| `import "https://deno.land/std/..."` | Local shim (auto) |

---

<a name="chinese"></a>
## 中文

SupaCloud Edge Functions 使用 **Bun + Elysia Worker 线程池** 作为推荐运行时，替代旧版 Deno V8 Worker 方案。

### 为什么切换？

| | Deno (旧版) | Bun (新版) |
|--|----------|---------|
| 内存 (200 函数) | ~1.4GB | **~140MB** |
| 冷启动 | 40-60ms | 8-15ms |
| 用户代码改动 | — | **零改动** |
| 端口 | :9000 | :9000 (不变) |

### 架构

```
SupaCloud (:3000)             Edge Runtime (:9000)
├── Management API       ←──  Bun.spawn() + 崩溃自动重启
└── 仅监听 :3000              ├── Elysia Server
                              ├── Worker 线程池 (4 线程, 固定 ~80MB)
                              ├── Deno 兼容层 (globalThis.Deno)
                              └── URL Import 插件 (deno.land/esm.sh → npm)

Kong/Angie 网关:
  /api/*        → :3000 (管理 API)
  /functions/*  → :9000 (Edge Runtime 直连)
```

### 依赖管理

**Edge Runtime 依赖**（Elysia 等）声明在 `packages/edge-runtime/package.json` 中。

**用户函数依赖** 在部署时自动扫描安装：
- `npm:xxx` — Bun 原生支持 ✅
- `https://esm.sh/xxx` — URL Plugin 转为 npm 包名，自动安装 ✅
- `https://deno.land/std/...` — 映射到本地 shim ✅
- 其他 npm 包 — 自动扫描安装 ✅

用户可以使用**任何框架或不使用框架**：

```typescript
// 方式 A: 裸 handler（零依赖）
export default (req: Request) => new Response("hello");

// 方式 B: Elysia（推荐，性能最优）
import { Elysia } from "elysia";
export default new Elysia().get("/", () => "hello");

// 方式 C: 其他框架（Hono、itty-router 等）
import { Hono } from "hono";
export default new Hono().get("/", (c) => c.text("hello"));
```

### 从 Deno 迁移

**步骤 1**：切换运行时
```bash
./switch.sh runtime bun
```

**步骤 2**：部署函数 — **无需修改任何代码**
- `Deno.env.get()` → Deno 兼容层自动处理
- `https://deno.land/std/...` 导入 → URL Import Plugin 自动处理
- `https://esm.sh/...` 导入 → 自动转为 npm 包
- `fetch("http://localhost:9000/...")` → 端口不变，直接可用

**步骤 3**：验证
```bash
curl http://localhost:9000/health
curl http://localhost:9000/functions/v1/your-function
```

### API 映射表 (Deno → Bun)

| Deno API | Bun 等价 |
|----------|---------|
| `Deno.serve()` | `Elysia().listen()`（运行时统一处理） |
| `Deno.readTextFile(path)` | `Bun.file(path).text()` |
| `Deno.env.get(key)` | `process.env[key]` |
| `Deno.stat(path)` | `fs/promises.stat()` |
| `new Worker(url, { deno: { permissions } })` | `new Worker(path)` |
| `import "https://esm.sh/xxx"` | `import "xxx"`（自动） |
| `import "https://deno.land/std/..."` | 本地 shim（自动） |
