# Edge Runtime Guide

SupaCloud Edge Functions uses **Bun + Elysia Worker Thread Pool** as the runtime.

By default, the runtime runs in **embedded mode** under `supacloud.service` together with the Management API. A standalone `supacloud-edge-runtime.service` is also available for **external mode**, but the two modes are mutually exclusive and must not own port `9000` at the same time.

## Architecture

```
SupaCloud (:9090)             Edge Runtime (:9000)
├── Management API       ←──  supacloud.service (default, embedded mode)
├── SSE Log Stream (/logs/stream)
├── WebSocket (/ws/tasks)     ├── Elysia Server
└── Static Assets (ETag/304)  ├── Worker Thread Pool (4 threads, fixed ~80MB)
                              ├── Compatibility Shim (globalThis.Deno)
                              ├── URL Import Mapping (compat imports → npm/shims)
                              └── /preheat endpoint (zero cold-start)

Caddy Gateway (Admin API-driven):
  Automatic HTTPS, security headers, route JSON publishing, CORS, rate limiting
  /api/*        → :9090 (Management API)
  /functions/*  → :9090 (Management API sdk-proxy)
  /realtime/*   → :9090 (Management API websocket proxy)
```

## Runtime Ownership

SupaCloud supports two deployment modes for the Bun Edge Runtime:

| Mode | Owner | Default | Notes |
|------|-------|---------|-------|
| `embedded` | `supacloud.service` | Yes | Management API starts the Edge Runtime child process itself. |
| `external` | `supacloud-edge-runtime.service` | No | Use only when you explicitly want a separate systemd unit. |

Set the mode through `EDGE_RUNTIME_MODE` in `/etc/supabase/management-api.env`.

Important:
- `embedded` is the installer default.
- `external` should only be enabled if you intentionally run a dedicated `supacloud-edge-runtime.service`.
- Do **not** run both modes at once; they will compete for port `9000`.

## Performance

| Metric | Value |
|--------|-------|
| Memory (200 functions) | ~140MB |
| Cold start (no preheat) | 8-15ms |
| Cold start (with preheat) | **0ms** |
| Port | :9000 |

### Function Preheating

After deploying a function, SupaCloud automatically pre-imports the module into the Worker Thread Pool's LRU cache. This eliminates cold-start latency on the first real request.

```
Deploy flow:
  1. Bun.build() bundles source → .js
  2. invalidateCache() clears old version
  3. POST /preheat/:ref/:slug → Worker imports module ahead of time
  4. First request hits warm cache → 0ms cold-start
```

## Dependency Management

**Edge Runtime dependencies** (Elysia etc.) are declared in `packages/edge-runtime/package.json`.

The Bun entrypoint is `packages/edge-runtime/server.ts`. Production Release installs render the standalone unit with `/usr/local/bin/supacloud-edge-runtime`; Bun source mode is available only when local installation is explicitly selected with `SUPACLOUD_SETUP_ARTIFACT_MODE=local`.

**User function dependencies** are auto-scanned during deployment:
- `npm:xxx` — Bun native support ✅
- `https://esm.sh/xxx` — URL import mapping converts to npm package ✅
- `https://deno.land/std/...` — Mapped to local shims for compatibility ✅
- Other npm imports — Auto-scanned and installed ✅

## Outbound HTTPS Trust

Edge Runtime release assets are native `supacloud-edge-runtime` binaries, not
Node.js processes. `NODE_TLS_REJECT_UNAUTHORIZED=0` is therefore not the
supported control surface for user function `fetch()` calls.

For private/self-signed services, prefer adding the issuing CA:

```bash
# Host-level CA bundle, read by supacloud-edge-runtime.service through /etc/supabase/management-api.env
SUPACLOUD_EDGE_TLS_CA_FILE=/etc/supacloud/edge-runtime/ca.pem

# Or project/function-level inline PEM through Edge Function secrets
SUPACLOUD_EDGE_TLS_CA='-----BEGIN CERTIFICATE-----...'
```

If compatibility requires fully bypassing certificate verification, set the
explicit dangerous switch:

```bash
SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY=true
```

The bypass is scoped to HTTPS `fetch()` calls inside Edge Function workers. It
does not disable TLS verification for the Management API, Caddy, tenant
PostgREST/GoTrue services, or other host processes.

## Function Examples

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

## SDK Compatibility

The Edge Runtime is fully compatible with `supabase.functions.invoke()`:

```typescript
const { data, error } = await supabase.functions.invoke('my-function', {
  body: { name: 'world' },
});
```

### Verified JWT Context

When a request enters the public `/functions/v1/*` path for a function with
`verify_jwt: true`, the Edge Runtime verifies the bearer JWT before dispatch and
exposes its verified subject through
`x-supacloud-jwt-sub`. Any client-supplied value for this header is removed and
replaced by the runtime, so functions may use it as the authenticated user ID
without calling GoTrue `getUser()` again.

The runtime emits this header only when the signed `sub` value is non-empty and
can be represented exactly as an HTTP header value. Otherwise the header stays
absent while the original `Authorization` header remains available.

The original `Authorization` header is preserved. Use that user JWT with a
user-scoped Supabase client so PostgREST applies RLS when loading the local
membership/profile record:

```typescript
const authorization = req.headers.get("authorization");
const userId = req.headers.get("x-supacloud-jwt-sub");

if (!authorization || !userId) {
  return new Response("Unauthorized", { status: 401 });
}

const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: authorization } },
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: membership, error } = await userClient
  .from("profiles")
  .select("id, username, role")
  .eq("id", userId)
  .maybeSingle();
```

API-key-only requests and raw anon/service-role key bypasses do not receive a
verified subject header. Authorization roles should come from the RLS-protected
membership lookup, not from an unverified client header.

Background dispatch also strips client-supplied values for this header. It does
not currently inject a subject because queued execution may outlive the original
JWT validity window; background jobs should persist an already-authorized user
identifier in their trusted task payload instead of treating request headers as
durable identity.

Background invocation uses the same API surface. SupaCloud supports two activation modes:

- server-side per-function `background_routes`

For browser-facing apps, prefer `background_routes` so the request stays free of custom async headers:

```typescript
const { data, error } = await supabase.functions.invoke("my-function/generate", {
  body: { job: "long-running" },
});
```

See [Background Functions](./background-functions.md) for the full execution model, cancellation semantics, and a cancellation-aware example handler.

### Recommended Background Strategy

For production heavy routes, use function config:

```json
{
  "verify_jwt": false,
  "background_routes": [
    "/generate/crop",
    "/generate/matting"
  ]
}
```

With `background_routes`, requests that hit those subpaths will be enqueued even if the browser does not forward custom `x-supacloud-*` headers. This is the recommended model for `supabase-js` clients running behind CDNs, browser caches, or mixed frontend bundle versions.

## Realtime Gateway Model

Browser websocket traffic should enter through the Management API first:

- public route: `/realtime/v1/websocket`
- upstream owner: Management API websocket proxy on `:9090`
- Realtime container remains the internal upstream

Do not route browser websocket traffic straight from Caddy to the Elixir Realtime container's `/socket` path. That older topology is prone to:

- tenant host/path mismatches
- wrong upstream rewrite behavior
- websocket handshakes succeeding while channel joins fail against the wrong tenant context

The current supported model is:

```text
browser -> Caddy -> Management API (:9090) -> Realtime upstream
```

## Realtime Tenant Recovery

If a project's Realtime channel fails after install, migration, or manual environment edits, use:

```bash
cd /opt/supacloud/packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

`realtime:reconcile`:

- registers missing tenants
- updates tenant connection metadata
- repairs tenant DB credentials

`realtime:reconcile-schema`:

- ensures the `realtime` schema exists in project databases
- grants required schema/table/sequence/routine privileges
- sets default privileges for future objects
- ensures `public.tasks` is published through `supabase_realtime` with full row images

For new installs, `install.sh` now generates a valid `REALTIME_DB_ENC_KEY`. Older installs that used an invalid key may need a one-time env fix plus the reconciliation commands above.

## Compatibility Shim

The runtime is Bun-native. Compatibility shims allow legacy Deno-oriented user code to keep running while the recommended authoring model stays on standard Bun/Request/Response APIs.

| Legacy Pattern | Recommended Pattern |
|----------------|---------------------|
| `Deno.serve()` | default exported handler |
| `Deno.readTextFile(path)` | `Bun.file(path).text()` |
| `Deno.env.get(key)` | `process.env[key]` |
| `Deno.stat(path)` | `fs/promises.stat()` |
| `import "https://esm.sh/xxx"` | `import "xxx"` |
| `import "https://deno.land/std/..."` | built-in shim or platform-native API |

## Service Management

```bash
# Check overall platform status
supacloud status

# View platform logs
supacloud logs

# View dedicated runtime logs when external mode is enabled
supacloud logs supacloud-edge-runtime

# Restart the platform entrypoint
systemctl restart supacloud

# Restart standalone runtime only in external mode
systemctl restart supacloud-edge-runtime

# Deploy a function
curl -X POST http://localhost:9090/api/functions/deploy \
  -H "Content-Type: application/json" \
  -d '{"ref":"PROJECT_REF","slug":"hello","code":"export default () => new Response(\"hi\")"}'
```

If you use the default installer path, prefer `supacloud` lifecycle commands for status and logs, and only interact with `supacloud-edge-runtime.service` directly when `EDGE_RUNTIME_MODE=external`.
