/** Shared reactive conventions for command, HTTP and edge starters. */
export const STARTER_REACTIVE_GUIDE = `# Reactive development / 响应式开发

RxJS is installed by default. Ordinary queries and business commands still use
async/await. Use RxJS for ongoing events and timing/composition, not as a new
transaction, retry or durable-delivery system.

- Import native operators from rxjs; do not invent another event/operator library.
- Import takeUntilAborted / toReadableStream from @supacloud/app/reactive.
- Every subscription belongs to a request, connection, task or application owner.
  Bind the owner's AbortSignal before starting work; release it on exit.
- toReadableStream has a bounded item buffer and fails on overflow. It is not
  an event journal. Do not silently drop durable business events or audit records.
- Never wrap command submission in defer/retry/repeat or submit from subscribe.
  Await the existing governed command and then observe its existing receipt.
- Do not shareReplay authenticated values globally across projects or sessions.
- subscribe(async ...) does not await processing. Keep acknowledged task-output
  consumers on the SDK's for-await watch path; do not advance onCursor via next().

## SupaCloud JS

The platform SDK is @supacloud/js, not a replacement Supabase client. Keep the
client from createSupaCloudClient. Database/Auth/Storage calls use client.supabase;
platform commands/tasks use the existing client.commands / client.tasks APIs.
For applications using this SDK, import observeQuery and observeTask from
@supacloud/js/reactive. Pass the request signal to the native query builder:

    observeQuery(signal => client.supabase.from("widgets").select("id").abortSignal(signal), { signal: owner.signal })

The query result keeps data/error/count/status; non-null errors enter error().
The query factory runs once per subscriber. This is intended for reads, not
replaying writes. A PromiseLike is supported; an already-started Promise is not
an appropriate factory. Unsubscribe aborts cooperative I/O, not committed work.

Submit a background task ONCE with the existing SDK, then observe the receipt:

    const task = await client.functions.invokeBackground("render", { body: input });
    const progress = observeTask(task, { signal: owner.signal });

Unsubscribing progress does not cancel the server task. Task read/decoder errors
terminate observation; there is no automatic business retry. Realtime-to-polling
fallback and project validation remain the SDK's responsibilities. Do not invent
a public.tasks table or copy service credentials into browser code.

Run bun run check. Add cancellation, error, overflow and cross-owner isolation
coverage whenever adding streaming behavior. These APIs require the matching
framework/SDK release or the packed candidate packages used by repository CI.
`;

export const STARTER_REACTIVE_AGENTS = `# Application development rules

Read README.md and REACTIVE.md before adding asynchronous features.
Prefer the generated contracts and existing project-bound @supacloud/js client.
Use async/await for a single result; RxJS is the default event-composition library.
Bind subscriptions to an explicit owner and propagate cancellation to native I/O.
Never automatically retry a write or turn observable delivery into durable ack.
Do not bypass authorization, transactions, idempotency or audit to simplify code.
Run bun run check; include negative and cleanup tests. Never store live credentials.
`;

export const STARTER_REACTIVE_TEST = `import { expect, test } from "bun:test";
import { Observable } from "rxjs";
import { takeUntilAborted, toReadableStream } from "@supacloud/app/reactive";

test("the owner's signal releases reactive work exactly once", () => {
  const owner = new AbortController();
  let starts = 0, stops = 0;
  const source = new Observable<number>(() => { starts++; return () => { stops++; }; });
  source.pipe(takeUntilAborted(owner.signal)).subscribe();
  owner.abort();
  source.pipe(takeUntilAborted(owner.signal)).subscribe();
  expect(starts).toBe(1);
  expect(stops).toBe(1);
});

test("cancelled stream consumers release their subscription", async () => {
  let stops = 0;
  const source = new Observable<number>(() => () => { stops++; });
  const stream = toReadableStream(source);
  await stream.cancel();
  expect(stops).toBe(1);
});
`;
