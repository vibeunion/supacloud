# Background Functions

SupaCloud Background Functions let tenants run long-lived Edge Function work through the same `supabase.functions.invoke()` API they already use for synchronous calls.

The platform persists the invocation as a task, executes it in the background pool, retries it when appropriate, and exposes status, logs, DLQ state, and cancellation controls in the control plane.

## What Changes For Tenants

Your function code still receives a normal `Request`.

The main change is at the caller:

```ts
const { data, error } = await supabase.functions.invoke("mockup-generator", {
  body: {
    product_id: "prod_123",
    image_url: "https://example.com/source.png",
  },
  headers: {
    "x-supacloud-async": "true",
    "x-supacloud-retries": "3",
    "x-supacloud-timeout": "300",
    "x-supacloud-idempotency-key": "mockup-prod_123-v1",
  },
});

console.log(data);
// { task_id: "tsk_...", status: "enqueued" }
```

In practice, the recommended tenant integration is:

1. keep using official `supabase.functions.invoke()`
2. enable SupaCloud background execution through `x-supacloud-*` headers
3. wrap that call in a small `invokeAsync()` helper inside your app or SDK layer

That gives you a `functions.invoke(async)` style developer experience without giving up compatibility with the official Supabase JavaScript client.

When `x-supacloud-async: true` is present:

- The request returns `202 Accepted`
- The function runs in the background pool
- The platform tracks attempts, logs, retries, cancellation, and DLQ state

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
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

serve(async (req) => {
  const payload = await req.json();
  req.signal.throwIfAborted?.();

  const taskId = Deno.env.get("SUPACLOUD_BACKGROUND_TASK_ID");
  const attempt = Deno.env.get("SUPACLOUD_BACKGROUND_ATTEMPT") || "1";

  const abortController = new AbortController();
  const onAbort = () => abortController.abort("supacloud task cancelled");
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (let step = 0; step < 10; step += 1) {
      req.signal.throwIfAborted?.();

      console.log(`[task=${taskId}] attempt=${attempt} step=${step}`);
      await sleep(1000, abortController.signal);
    }

    // Make the write idempotent in your own database layer.
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
});
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
