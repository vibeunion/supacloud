# Edge Function memory controls

Ordinary responses larger than 64 KiB and SSE responses use a credit-driven
MessagePort bridge. Each credit transfers one owned chunk of at most 512 KiB.
The main process can read ahead within a shared 256 MiB budget and a 16 MiB,
256-chunk per-response window. A completed response can continue from that
buffer after its Worker is reused; the buffered bytes remain charged until
consumed or cancelled. When the budget is full, producers stop reading.
The producer's Buffer/Uint8Array storage is never detached. Small ordinary
responses retain a buffered fast path; multiple Set-Cookie values and binary
subviews are preserved. Do not collect all dispatch results before consuming
large bodies: active streams occupy worker slots, so consume each response as
soon as its headers arrive.

The request deadline remains active while a streamed response is being produced,
including when the client stops reading. Client cancellation and Worker exit
settle pending readers and release reservations. A Worker becomes reusable only
after body production, nested `EdgeRuntime.waitUntil` tasks, and environment/TLS/
console cleanup finish. The waitUntil deadline starts after body production;
late tasks registered by stream producers and failing handlers are included.
Response delivery has a separate idle timeout using the request timeout setting.
Graceful drain waits for both active executions and unfinished deliveries.
Small buffered responses also release reservations on cancellation, HTTP abort,
or delivery timeout, even after their Worker has been reused.

HTTP abort, stream cancellation and request timeout now request cooperative
cancellation identified by an execution key. The caller receives 499/504 promptly;
the slot stays occupied until execution cleanup finishes. A cancellation ack
alone never makes the Worker reusable. Workers that do not finish within the
three-second cleanup grace period are retired. Worker errors and expired
waitUntil deadlines still retire immediately. Replacement/process recovery
budgets remain in force because backoff cannot reclaim retained native memory.

Requests are read incrementally into bounded pages and checked before the final
contiguous transfer is allocated. They are still fully validated before entering
the handler, including requests without Content-Length. This is not a streaming
upload API. A rejected body is cancelled immediately without draining it.
Response limit violations before headers return 502. Once streaming headers
have been sent, a later violation errors the response stream; its HTTP status
cannot be changed retroactively.

## Host configuration

New settings accept positive integer byte counts, except the generation limit
which counts imports and read-ahead which also accepts zero. Response-buffer
budgets must fit at least one 512 KiB chunk. Invalid settings fail initialization. Tenant env
cannot override these pool-level controls. Restart the runtime after changes.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `EDGE_BODY_BUFFER_BUDGET_BYTES` | 268435456 (256 MiB) | Shared foreground/background logical body reservations |
| `EDGE_RESPONSE_BUFFER_BUDGET_BYTES` | 268435456 (256 MiB) | Shared response read-ahead reservation cap, included in the overall body budget |
| `EDGE_RESPONSE_READ_AHEAD_BYTES` | 16777216 (16 MiB) | Per-response read-ahead window; zero selects strict demand-driven transport |
| `EDGE_WORKER_HEAP_BUDGET_BYTES` | 134217728 (128 MiB) | Collect a completed Worker heap above this threshold, then retire if it remains over budget |
| `EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS` | 250 | Minimum gap between `bun:jsc.heapStats()` heap samples per Worker; `0` samples after every execution |
| `EDGE_MODULE_BUDGET_BYTES` | 33554432 (32 MiB) | Retire on lifetime imported entry artifact/bytecode bytes above this threshold |
| `EDGE_MODULE_GENERATION_LIMIT` | 100 | Retire after this many distinct module identities in one Worker generation |
| `EDGE_RSS_BUDGET_BYTES` | unset | Optional process RSS admission/recycle threshold, also usable outside Linux |

Queued requests reserve their declared body length (capped at the request limit)
or the request limit when unknown, plus a response window. Active uploads reserve
page/transfer capacity. An unread buffered small response remains charged until
consumed or cancelled. Exhaustion returns 503 with Retry-After. Budget metrics
are logical reservations, **not** measured process RSS or a hard tenant-memory
sandbox. Tenant allocations, producer-owned chunks, engine/module objects,
native libraries, sockets and caller-retained consumed bodies require headroom.
Increase the response budget for higher slow-client throughput only when RSS
headroom is available. Strict read-ahead zero minimizes buffers but keeps
Workers occupied by slow consumers, increasing queue latency. Both modes retain
one handler per Worker because per-request environment and global policy change.

Removing entries from the handler LRU does not unload JSC modules. Lifetime
import counters survive cache eviction/invalidation and reset only on Worker
replacement. Artifact byte counts are estimates, not the size of the complete
import graph or its live heap. Worker-side `bun:jsc.heapStats()` supplies separate
post-execution/preheat heap telemetry. A preheat that exceeds a budget fails
instead of attesting a Worker that is immediately discarded. Existing process
recycle limits still bound long-term Worker churn. These are soft completion-time
limits; CPU-blocking or memory-hungry tenant code still needs OS process limits.

`heapStats()` walks the isolate heap, so it costs hundreds of microseconds on a
warm Worker and milliseconds once a tenant retains live data. Sampling it on every
execution therefore dominated small-request latency and made throughput degrade as
heaps grew. Workers now report the most recent sample and refresh it at most once
per `EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS` (preheat still forces a fresh sample).
Heap-retirement and memory-gauge decisions are consequently accurate to within one
sampling interval instead of one request; process RSS and cgroup admission checks
are unaffected and remain the fast fail-safe for runaway allocation.

Linux monitoring compares every cgroup ancestor against its own usage. A finite
`memory.max` supplies a threshold at 90% when `memory.high` is absent or higher.
This fallback and explicit RSS budgets block admission proactively at 85% of
their threshold. Sustained threshold breaches trigger the existing graceful
runtime recycle. Keep systemd/container hard limits as the final OOM boundary.
Existing pool-size overrides, `smol`, bytecode support and project isolation remain
in force. A lower buffer budget bounds memory by queueing/rejecting work; slow
consumers can consequently increase end-to-end latency.

## Metrics and diagnosis

The authenticated `/metrics` endpoint reports process RSS and JSC current commit
once, shared body/response buffer reserved/peak/budget bytes, overall body admission rejections, and per-pool
summed last-reported Worker heap/capacity/extra-memory bytes plus memory-driven
retirements. Extra memory is already represented in heap statistics; do not add
it again. Process RSS is not a per-worker measure and must not be summed across
workers. Worker samples are last-completion samples, not continuous live peaks.

Use `process.memoryUsage().rss`, `bun:jsc.memoryUsage()` and worker-side
`heapStats()` for their respective scopes. Bun 1.4.3 has no `Bun.memoryUsage()`.
ReadableStream transfer through MessagePort is unsupported in this tested Bun;
the bridge transfers owned ArrayBuffers instead. Normal completions do not force GC. When a completed Worker or preheat exceeds
its soft heap budget, a captured `Bun.gc(true)` collects once and the heap is
sampled again before retirement. This avoids replacing warm Workers for dead
buffers, at the cost of collection time on pressure events. The collector is
captured before tenant code can replace the global API. Process-wide periodic GC
was evaluated and not retained; it did not reliably reduce peak RSS. No public
heap-snapshot endpoint is added. The benchmark also forces GC once before timing.

## Reproduction

From `packages/edge-runtime`:

```sh
bun run bench:memory --mode ordinary
bun run bench:memory --mode sse
bun run bench:memory --batches 10
bun run bench:memory --batches 10 --pause-ms 0 --delay-per-64k-ms 0
bun run bench:memory --mode ordinary --pool-module /absolute/baseline/packages/edge-runtime/worker-pool.ts
```

Each run starts a separate process with four smol Workers, warms 30 small requests,
then runs 30 concurrent 8 MiB responses. Each client waits 250 ms before consuming
and then reads at a byte-based delay of 1 ms per 64 KiB. The script reports peak
RSS, delivered bytes, completion latency, reservations and replacements. Baseline
and candidate must use the same Bun version and workload; run sequentially.
Local macOS results do not prove production Linux RSS or resolve an unobserved
4 GiB incident. Validate with the affected function, payloads and deployment
cgroup before changing production limits.

## Official runtime references

Checked on 2026-10-26 directly from the publishers:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  one isolate can serve concurrent requests; CPU time excludes network wait;
  memory limits apply to the isolate. These semantics cannot be copied into
  SupaCloud while request env and global policies are mutated per invocation.
- [Node stream buffering](https://nodejs.org/api/stream.html#buffering):
  highWaterMark provides bounded read-ahead/backpressure, but is a threshold,
  not a hard whole-process memory limit. The implementation here adds a shared
  byte reservation budget across worker pools.
- [Bun Worker smol](https://bun.com/docs/runtime/workers#memory-usage-with-smol):
  smol trades performance for memory by selecting JSC's Small heap mode. It is
  already enabled by default in SupaCloud; toggling it is not a substitute for
  removing full-response aggregation and bounding queues.

No single throughput number is comparable across different function code,
response sizes, CPU/wall-time definitions, isolation models or client rates.
Use the local benchmark's RSS, header p95, completion p95, delivered bytes and
process CPU together. Test fast clients with `--pause-ms 0 --delay-per-64k-ms 0`.

## Local throughput/memory tradeoff (2026-10-26)

Performance acceptance is **PARTIAL**. Correctness checks pass, but continuous
slow-reader RSS is higher than the baseline in this fixture. The logical buffer
cap is not a process RSS limit. Do not present this implementation as a verified
fix for the reported production 4 GiB incident or roll it out on that assumption.

Final comparison: macOS arm64, Bun 1.4.3, four smol Workers, ten consecutive batches
of 30 requests with 8 MiB bodies (300 requests and 2400 MiB delivered per process).
Each configuration ran in three fresh processes; the table shows medians. In the
slow case each client pauses 250 ms after headers, then consumes at 1 ms per
64 KiB. Fast clients have no artificial delay. RSS is sampled every 5 ms; p95
latencies start at each batch's dispatch, and RPS uses the full timed workload.
This is a sequence of closed batches, not a constant-arrival HTTP/TLS load test.

| Client / implementation | Peak RSS MiB | Header p95 ms | Completion p95 ms | RPS | Process CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fast / baseline | 373 | 67 | 67 | 637 | 1150 |
| Fast / final | 263 | 46 | 51 | 612 | 1516 |
| Slow / baseline | 656 | 51 | 431 | 71 | 1563 |
| Slow / final | 830 | 42 | 422 | 72 | 1462 |

Fast-client peak RSS falls about 29% and completion p95 about 24%, while measured
RPS falls about 4% and CPU rises about 32%. For slow clients, throughput and
completion time are similar, but peak RSS rises about 27%. Slow baseline RSS
ranges from 553 to 753 MiB; final RSS ranges from 819 to 830 MiB. All final runs
delivered the expected bytes, released all reservations, and needed no Worker
replacement. These short local runs are not a production SLA or evidence that
all functions use less memory.

The final 512 KiB frame is a compromise between message overhead and admission
reservation size; the small-response fast path remains 64 KiB. Worker pressure
collection prevented the unnecessary replacements observed before collection.
Neither this nor a 256 MiB logical body budget provides a hard bound on process
RSS: JSC/native allocators, live tenant data, and retired Workers still contribute.
Cgroup/process admission and OS hard limits remain necessary. The remaining
acceptance work is to profile the continuous slow-reader RSS regression and
repeat HTTP/TLS load tests on Linux with the affected function and deployment
limits. Reducing read-ahead without measuring queue time is not sufficient.

### How much memory should read-ahead trade for throughput?

Earlier single-burst, 256 KiB-frame experiments used the same 30-request/8 MiB
slow-client fixture. They illustrate policy choices; these are not measurements
of the final 512 KiB implementation. Each row is the median of three runs.

| Read-ahead policy | Peak RSS MiB | Header p95 ms | Completion p95 ms | Burst RPS |
| --- | ---: | ---: | ---: | ---: |
| Baseline whole-response aggregation | 449 | 32 | 413 | 73 |
| Strict demand-driven | 105 | 2785 | 3181 | 9 |
| Shared response cap 64 MiB | 301 | 689 | 1076 | 27 |
| Shared response cap 128 MiB | 345 | 341 | 728 | 41 |
| Shared response cap 256 MiB | 377 | 65 | 452 | 66 |

The current 256 MiB default prioritizes queue latency and throughput. Hosts that
prioritize memory can lower the response cap to 64 or 128 MiB, accepting extra
queue time. Strict mode is appropriate only when holding workers behind slow
consumers is acceptable. The response reservation is included in the overall
256 MiB body budget; uploads and queued requests share that overall cap.

### Implementation validation

- Edge Runtime typecheck passed.
- Focused Edge Runtime suite: 163 passed, 7 Linux-only tests skipped, 0 failed.
- Management child-process credential/environment boundary: 6 passed, 0 failed.
- macOS arm64 compiled binary built and `--version` smoke test passed.
- Targeted independent lifecycle review covered cleanup and reuse isolation.
- Continuous cancellation tests preserve warm module identity across 30 aborts;
  cancellation during waitUntil cannot release the execution slot early or
  extend an existing waitUntil deadline.
- No deployment, Linux production acceptance, or resolution of the reported
  production incident is claimed. Git delivery is recorded by the associated PR.

Raw records, including the earlier 64/256 KiB and later 512 KiB/1 MiB frame
experiments, are in [edge-memory-20261026.json](benchmarks/edge-memory-20261026.json).
The baseline uses unchanged WorkerPool/Executor code in the original checkout
at `b6cff5a4117a093fb7c75034bf09575eddb74bd8`. Candidate changes are isolated on
`codex/function-memory-20261026`, based on main
`3dd8c786c1b9971532b3eb5b8c76efb764982e30`.
