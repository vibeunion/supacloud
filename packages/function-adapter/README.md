# @supacloud/function-adapter

[English](#english) | [中文](#中文)

## English

Fetch-based adapters for SupaCloud Edge Functions.

The adapter returns a default-exportable object with `fetch(request)` and
explicit SupaCloud metadata. It never listens on a port, starts a process, or
serves static assets.

```ts
import { createSupaCloudHandler } from "@supacloud/function-adapter";

export default createSupaCloudHandler(
  (request) => Response.json({ path: new URL(request.url).pathname }),
  "hono",
);
```

For SvelteKit API-only builds, wrap the generated server `respond` function:

```ts
import { createSvelteKitHandler } from "@supacloud/function-adapter/sveltekit";

export default createSvelteKitHandler({ respond: server.respond.bind(server) });
```

Or configure the build adapter directly:

```js
import adapter from "@supacloud/function-adapter/sveltekit-adapter";

export default {
  kit: { adapter: adapter() },
};
```

The SvelteKit adapter rejects page routes, prerendered output, static assets,
server asset reads, and instrumentation. API routes and `hooks.server` remain
supported.

Use the `sveltekit-function` profile only for Fetch-compatible server routes.
Complete SvelteKit SSR applications should continue to use SupaCloud Frontend
Hosting with an adapter-node process.

## 中文

`@supacloud/function-adapter` 为 SupaCloud Edge Functions 提供基于 Fetch 的适配器。

适配器返回一个可以默认导出的对象，包含 `fetch(request)` 和明确的 SupaCloud metadata。它不会监听端口、启动进程或提供静态资源：

```ts
import { createSupaCloudHandler } from "@supacloud/function-adapter";

export default createSupaCloudHandler(
  (request) => Response.json({ path: new URL(request.url).pathname }),
  "hono",
);
```

对于仅 API 的 SvelteKit 构建，可以包装生成的 server `respond` 函数：

```ts
import { createSvelteKitHandler } from "@supacloud/function-adapter/sveltekit";

export default createSvelteKitHandler({ respond: server.respond.bind(server) });
```

也可以直接配置 SvelteKit build adapter：

```js
import adapter from "@supacloud/function-adapter/sveltekit-adapter";

export default { kit: { adapter: adapter() } };
```

SvelteKit adapter 会拒绝页面路由、prerender 输出、静态资源、server asset 读取和 instrumentation；API 路由与 `hooks.server` 仍然支持。

只有 Fetch 兼容的 server route 才应使用 `sveltekit-function` profile。完整的 SvelteKit SSR 应用应继续使用带 adapter-node 进程的 SupaCloud Frontend Hosting。
