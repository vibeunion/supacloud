# @supacloud/function-adapter

Fetch-based adapters for SupaCloud Edge Functions.

The package also provides generic HTTP invocation adapters for application
workers. `createWorkerHttpHandler` handles POST validation, a shared-secret
header, bounded `batchSize` input, stable error responses, and no-store
responses. `createScheduledWorkerHttpHandler` handles POST validation and
either a service-role bearer or an application-provided verifier.

These adapters do not own queue claims, leases, retries, business
authorization, or domain state. Applications inject those concerns through
`runBatch`; FA can use them for its worker entry points while keeping FA task
decoding, membership authorization, provider authorization, and command
receipts in the application.

```ts
import {
  createSupaCloudHandler,
  createWorkerHttpHandler,
} from "@supacloud/function-adapter";

export default createSupaCloudHandler(createWorkerHttpHandler({
  expectedSecret: process.env.WORKER_SECRET ?? "",
  defaultBatchSize: 5,
  maxBatchSize: 20,
  runBatch: ({ batchSize }) => applicationWorker.runBatch(batchSize),
}));
```

The worker accepts an empty body or a JSON object with an optional `batchSize`.
The default header is `x-supacloud-worker-secret`; `secretHeader` and `errorCodes`
can preserve an application's existing invocation contract. Batch bounds are
validated when constructing the handler. Secrets must have at least 32
characters. Missing or weak secrets fail closed with HTTP 503.

For scheduled invocations, supply exactly one of `expectedBearer` (the full
expected token, without the `Bearer ` prefix) or `authorize(request)`. A bearer
is compared to the configured secret; this is not JWT claim verification.
Use `authorize` for a platform JWT/signature verifier. Never authorize a token
merely by decoding a `service_role` claim.

Both adapters return `{ ok: true, result }` on success, with HTTP 200 by default.
`successStatus` may select 202 for delegated execution. Errors use
`{ ok: false, error: { code } }` (the worker also includes a generic message).
They never include exception details. Optional `logError` receives the original
exception for application-controlled reporting; redact credentials before
logging it. These adapters do not register cron jobs, start polling loops, or
replace `createWorker()` / `createSupAuthRequestContext()` in `@supacloud/elysia`.
Publishing this package does not migrate existing application entry points.

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

Or configure the build adapter in the Vite SvelteKit plugin:

```js
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@supacloud/function-adapter/sveltekit-adapter";

export default {
  plugins: [sveltekit({ adapter: adapter() })],
};
```

The SvelteKit adapter rejects page routes, prerendered output, static assets,
server asset reads, and instrumentation. API routes and `hooks.server` remain
supported.

Use the `sveltekit-function` profile only for Fetch-compatible server routes.
Complete SvelteKit SSR applications should continue to use SupaCloud Frontend
Hosting with an adapter-node process.
