# Edge Runtime Guide

SupaCloud Edge Functions uses **Bun + Elysia Worker Thread Pool** as the runtime.

By default, the runtime is started in **embedded mode** by `supacloud.service` (the Management API service). A standalone `supacloud-edge-runtime.service` is also available for **external mode**, but the two modes are mutually exclusive and must not own port `9000` at the same time.

## Architecture

```
SupaCloud (:9090)             Edge Runtime (:9000)
├── Management API       ←──  supacloud.service (default, embedded mode)
├── SSE Log Stream (/logs/stream)
├── WebSocket (/ws/tasks)     ├── Elysia Server
└── Static Assets (ETag/304)  ├── Worker Thread Pool (4 threads, fixed ~80MB)
                              ├── Deno Compat Shim (globalThis.Deno)
                              ├── URL Import Plugin (deno.land/esm.sh → npm)
                              └── /preheat endpoint (zero cold-start)

Kong Gateway (API-driven, native OpenResty):
  Global: ACME SSL, Gzip, Security Headers
  Per-route: CORS, Rate Limiting, JWT
  /api/*        → :9090 (Management API)
  /functions/*  → :9000 (Edge Runtime, direct)
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

The Bun entrypoint is `packages/edge-runtime/server.ts`, and the checked-in standalone unit runs `bun run server.ts` from `/opt/supacloud/edge-runtime`.

**User function dependencies** are auto-scanned during deployment:
- `npm:xxx` — Bun native support ✅
- `https://esm.sh/xxx` — URL Plugin converts to npm package ✅
- `https://deno.land/std/...` — Mapped to local shims ✅
- Other npm imports — Auto-scanned and installed ✅

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

Background invocation uses the same API surface with async headers:

```typescript
const { data, error } = await supabase.functions.invoke("my-function", {
  body: { job: "long-running" },
  headers: {
    "x-supacloud-async": "true",
    "x-supacloud-retries": "3",
    "x-supacloud-timeout": "300",
    "x-supacloud-idempotency-key": "job-long-running-v1",
  },
});
```

See [Background Functions](./background-functions.md) for the full execution model, cancellation semantics, and a cancellation-aware example handler.

## Deno Compatibility

Legacy Deno user code works without changes via the built-in shim layer:

| Deno API | Bun Equivalent |
|----------|---------------|
| `Deno.serve()` | `Elysia().listen()` (runtime handles this) |
| `Deno.readTextFile(path)` | `Bun.file(path).text()` |
| `Deno.env.get(key)` | `process.env[key]` |
| `Deno.stat(path)` | `fs/promises.stat()` |
| `import "https://esm.sh/xxx"` | `import "xxx"` (auto) |
| `import "https://deno.land/std/..."` | Local shim (auto) |

## Service Management

```bash
# Check Management API status (default embedded mode)
systemctl status supacloud

# Check standalone Edge Runtime status (external mode only)
systemctl status supacloud-edge-runtime

# Restart embedded mode
systemctl restart supacloud

# Restart external mode
systemctl restart supacloud-edge-runtime

# View embedded mode logs
journalctl -u supacloud -f

# View external mode logs
journalctl -u supacloud-edge-runtime -f

# Deploy a function
curl -X POST http://localhost:9090/api/functions/deploy \
  -H "Content-Type: application/json" \
  -d '{"ref":"PROJECT_REF","slug":"hello","code":"export default () => new Response(\"hi\")"}'
```

If you are using the default installer path, prefer `supacloud.service` commands because the Edge Runtime is normally embedded there.
