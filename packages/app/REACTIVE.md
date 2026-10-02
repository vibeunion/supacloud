# Default reactive support

RxJS is a declared runtime dependency. Use native operators from `rxjs` and
framework lifecycle/transport integration from `@supacloud/app/reactive`.
The root, `/execution`, `/browser` and `/contracts` contracts are unchanged;
this entry does not import Angular, Elysia, the compiler or Node-only modules.

```ts
import { map, type Observable } from "rxjs";
import { takeUntilAborted, toReadableStream } from "@supacloud/app/reactive";

// events must already be bound to an authorized project/connection.
export function streamProgress(events: Observable<{ progress: number }>, request: Request) {
  const bytes = events.pipe(
    takeUntilAborted(request.signal),
    map(event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
  );
  return new Response(toReadableStream(bytes, { signal: request.signal, capacity: 16 }), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
```

`takeUntilAborted` completes when its owner aborts and never subscribes an
already-aborted source. Normal RxJS unsubscription still applies.
`toReadableStream` subscribes on construction, releases the subscription on
cancel/abort/completion/error, and buffers at most `capacity` items (default 16,
range 1..65536). Overflow raises `ReactiveBufferOverflowError`; it does not drop
messages, wait for asynchronous observers, implement durable replay, or bound
individual message bytes. Enforce payload-size limits before this adapter.
Producer teardown must actually release its resources; unsubscription cannot
cancel an arbitrary Promise or roll back an external side effect.

Return the Response/ReadableStream through the native HTTP host. This change does
not make arbitrary Observable-returning controller methods supported and does
not extend request-scoped service lifetime until a response is consumed. Stream
resources need a connection-owned lifecycle, not a closed command transaction.

Keep single-result commands and AOP on `async/await`. Never automatically
resubscribe writes with `retry`/`repeat`. Keep authorization, transactions,
idempotency and audit inside the existing application executor. Avoid global
replay caches for project/user data. RxJS is the standard event library, not a
second workflow, DI, persistence or schema system.

New APIs are available in a release containing this entry or packed candidate
packages. Repository tests exercise cleanup, overflow and browser isolation;
production transport and database behavior still require application acceptance.
