# SupaCloud JS reactive calls

RxJS is installed as a direct SDK dependency. Import the official adapters from
`@supacloud/js/reactive`; ordinary SDK and `/contracts` imports do not import RxJS.
There is no replacement client, proxy or new authentication path.

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";
import { observeQuery, observeTask } from "@supacloud/js/reactive";

const supabase = createClient(projectUrl, publicKey);
const client = createSupaCloudClient({
  supabase, projectRef, managementApiUrl,
  // Supply getAccessToken only when using the existing configured identity flow.
});
const owner = new AbortController();

// Native data calls stay under client.supabase; generic row types and count survive.
const rows = observeQuery(signal => client.supabase
  .from("widgets").select("id", { count: "exact" }).abortSignal(signal),
  { signal: owner.signal });
const rowsSubscription = rows.subscribe({
  next: response => renderRows(response.data, response.count),
  error: error => showQueryError(error),
});

// A write is submitted once, not every time the UI subscribes.
const receipt = await client.functions.invokeBackground("render", { body: input });
const progressSubscription = observeTask(receipt, { signal: owner.signal }).subscribe({
  next: snapshot => renderProgress(snapshot),
  error: error => showObservationError(error),
});

// Component/connection shutdown stops observation, not the server-side task.
owner.abort();
rowsSubscription.unsubscribe();
progressSubscription.unsubscribe();
```

The sample assumes application-provided URLs, public key, input and UI handlers;
never put a service-role key or management administrator credential in a browser.
Database/Auth/Storage calls remain on the original `client.supabase` instance.
Commands, workflow calls, task cancellation/retry and submission remain the
existing awaited SDK APIs. No methods or return types on that client are changed.

## Query contract

`observeQuery` takes a **factory**, not an already-started Promise. It accepts
Supabase's PromiseLike query builders and creates one read per subscriber. It
emits the original successful envelope, retaining `data`, `count`, `status` and
other fields; a non-null `error` is forwarded unchanged to RxJS `error()`.
Synchronous exceptions and rejected promises are also forwarded unchanged.
There is no retry, global cache or implicit sharing. Keep writes on native awaited
APIs, since subscribing twice to a write factory could execute the write twice.

Pass the supplied signal to `.abortSignal(signal)` or supported SDK options.
Unsubscribe aborts cooperative pending I/O and ignores late results. Owner-signal
abort completes observation. It cannot stop an operation that ignores that signal
or undo a committed write. Completed requests are not spuriously aborted.

## Task contract

Pass the receipt returned by `tasks.submit` / `submitTyped` or
`functions.invokeBackground`. The decoder and project binding remain on the
receipt. For an already-known task ID, adapt the existing subscriber without
creating a second client:

```ts
const progress = observeTask({
  subscribe: options => client.tasks.subscribe(taskId, options),
}, { signal: owner.signal });
```

Each observer owns one existing SDK subscription. `stopOnTerminal` and optional
Realtime configuration are forwarded. Terminal statuses (including failed and
cancelled) are values, not transport errors; SDK close completes the stream.
Read/validation errors terminate observation without implicit resubmission.
Realtime connection failure can still fall back to SDK polling. No `public.tasks`
table is invented. Unsubscribe starts SDK cleanup and aborts its pending reads;
it does not synchronously await the SDK's asynchronous channel-removal operation.

## Durable output is intentionally different

Keep `@supacloud/js/task-events` and `for await ... of client.watch(...)` for
acknowledged output processing. Its `onCursor` advances only after the consumer
resumes the generator. RxJS `next()` and `subscribe(async ...)` do not await the
handler, so blindly applying `from(watch(...))` would acknowledge too early.
Do not use the progress snapshot adapter as an event journal or audit sink.

Use a release containing `/reactive`, or packed candidate packages during
repository acceptance. Existing deployed SDK versions do not gain this API
until upgraded.
