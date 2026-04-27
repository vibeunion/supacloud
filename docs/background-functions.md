# Background Functions

SupaCloud Background Functions let tenants run long-lived Edge Function work through the same `supabase.functions.invoke()` API they already use for synchronous calls.

The platform persists the invocation as a task, executes it in the background pool, retries it when appropriate, and exposes status, logs, DLQ state, and cancellation controls in the control plane.

## What Changes For Tenants

Your function code still receives a normal `Request`.

The main change is at the platform boundary:

```ts
const { data, error } = await supabase.functions.invoke("mockup-generator", {
  body: {
    product_id: "prod_123",
    image_url: "https://example.com/source.png",
  },
});

console.log(data);
// { task_id: "tsk_...", status: "enqueued" }
```

In practice, SupaCloud background execution is activated like this:

1. keep using official `supabase.functions.invoke()`
2. mark heavy subpaths with server-side `background_routes`
3. use Realtime or task APIs for status updates

For browser-heavy apps, `background_routes` is the preferred production model because it does not depend on custom headers surviving CDN, cache, or frontend bundle drift.

When a request is accepted for background execution through a configured route:

- The request returns `202 Accepted`
- The function runs in the background pool
- The platform tracks attempts, logs, retries, cancellation, and DLQ state

## Recommended Production Shape

For `supabase-js` apps, the cleanest production model is:

1. keep the public invoke call standard
2. mark heavy subpaths with server-side `background_routes`
3. use Realtime for status notifications
4. keep polling as a fallback rather than as the primary state channel

This avoids making browser correctness depend on custom `x-supacloud-*` headers surviving:

- old frontend bundles
- CDN caches
- cross-origin edge proxies
- browser preflight/header differences

## Execution Model

Background Functions are intentionally bounded:

- Tasks are persisted in the control plane before execution
- Delivery is `at-least-once`, not `exactly-once`
- Retries and DLQ are platform-managed
- Background execution is isolated from foreground HTTP invoke capacity
- Project-level concurrency and timeout limits still apply

You should design handlers to be idempotent.

## Cancellation Model

If a background task is cancelled from the control plane:

- SupaCloud sends a cancellation signal to the running invocation
- The current request's `signal` is aborted
- If the function does not stop in time, the runtime forcefully recycles the worker

This means your function can and should observe `req.signal`.

Runtime metadata is also injected:

- `SUPACLOUD_BACKGROUND_TASK_ID`
- `SUPACLOUD_BACKGROUND_ATTEMPT`
- `SUPACLOUD_CANCELLATION_SIGNAL=supported`

## Recommended Tenant Pattern

Use three rules in long-running functions:

1. Check `req.signal.aborted` before starting expensive work
2. Attach an `abort` listener to stop polling, streaming, or external waits
3. Make writes idempotent so retries or partial progress do not duplicate side effects

## Example: Cancellation-Aware Background Function

See [cancellable-background-function.ts](./examples/cancellable-background-function.ts).
For a tenant-facing `supabase-js` walkthrough that includes enqueue, polling, cancel, and DLQ handling, see [Background Functions With supabase-js](./background-functions-supabase-js-tutorial.md).

The pattern below is the important bit:

```ts
req.signal.throwIfAborted?.();

const onAbort = () => {
  controller.abort("background task cancelled");
};

req.signal.addEventListener("abort", onAbort, { once: true });
```

## Example: End-To-End Handler

```ts
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Task cancelled", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default async function handler(req: Request) {
  const payload = await req.json();
  req.signal.throwIfAborted?.();

  const taskId = process.env.SUPACLOUD_BACKGROUND_TASK_ID;
  const attempt = process.env.SUPACLOUD_BACKGROUND_ATTEMPT || "1";

  const abortController = new AbortController();
  const onAbort = () => abortController.abort("supacloud task cancelled");
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (let step = 0; step < 10; step += 1) {
      req.signal.throwIfAborted?.();

      console.log(`[task=${taskId}] attempt=${attempt} step=${step}`);
      await sleep(1000, abortController.signal);
    }

    return Response.json({
      ok: true,
      task_id: taskId,
      attempt,
      output: payload,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.warn(`[task=${taskId}] cancelled by control plane`);
      return Response.json({ ok: false, cancelled: true }, { status: 499 });
    }

    throw error;
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}
```

## Task Semantics To Document To Your Team

- Background tasks are `at-least-once`
- Use an idempotency key whenever the task has side effects
- Large payloads should be stored in Storage and referenced by key
- Return small results; write large outputs to Postgres or Storage yourself
- Cancellation is cooperative first, forceful second

## Project-Level Controls

Project admins can tune:

- background concurrency
- max attempts
- payload size limit
- default timeout
- max timeout

These settings live in the project background task configuration and are visible in the task console.

## Observability

Each task exposes:

- task status
- attempt history
- latest error
- stdout/stderr logs
- DLQ state
- retry history

The Web Console task page is the best place to inspect a running or failed background function.

## Realtime Status Delivery

Background execution and Realtime are intentionally separate concerns:

- task creation still happens through HTTP invoke and background enqueue
- Realtime is only the status transport

That means Realtime issues should degrade task UX, not task correctness:

- websocket/channel healthy → live task status updates
- websocket/channel unhealthy → fallback polling against task APIs or `public.tasks`

If task status subscriptions fail, first verify the platform side:

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

These commands repair the two historical failure modes:

- missing Realtime tenants
- missing `realtime` schema/database privileges
- missing `public.tasks` publication membership for `postgres_changes`

New tenant migrations also call SupaCloud's Realtime repair helper after SQL migrations, so projects that create `public.tasks` later are made subscribable without requiring a manual step.
