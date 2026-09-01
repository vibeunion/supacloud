# @supacloud/function-adapter

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
