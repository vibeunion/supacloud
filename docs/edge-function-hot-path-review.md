# Edge Function hot-path review (2026-10-26)

The submitted audit identifies real capacity and allocation costs, but its
microbenchmarks do not establish production throughput or the cause of a 4 GiB
incident. This review separates observed source behavior from proposed changes.

| Item | Source finding | Decision and remaining work |
| --- | --- | --- |
| Four foreground slots | `server.ts` defaults to four; one invocation owns each Worker until cleanup. Parked Workers do not add execution slots. | Production is not necessarily four: `management-api/src/upgrade.ts` already computes external-runtime capacity from CPU and memory limits. Preserve the explicit override and memory-aware policy; do not increase to 16 on CPU count alone. |
| Manifest/config/artifact verification | `getFunctionConfig` checks project release before its legacy cache. `assertDispatchAuthorityCurrent` reads authority and artifact; executor also checks artifact before entering tenant code. | Hot path exists. A bounded digest/parsed-manifest cache is worth implementing, but must retain trusted descriptors, ownership/mode checks, path bindings, activation fences and revocation. Simply moving a TTL lookup before authority detection can authorize stale policy. Not implemented in this change. |
| Cancellation/replacement | Abort previously waited for lifecycle completion or retired; stream cancellation and timeout retired directly. | Implemented cooperative cancellation, keyed to one execution, with a three-second cleanup deadline and reuse only after completion. Keep forced retirement for hung execution and process recovery for retained memory. An ack only confirms receipt, not termination. |
| waitUntil occupancy | Background promises retain the originating Worker's env, console, TLS, bindings and slot. | True capacity cost. Closures cannot be transferred into another Worker pool. Separate serializable background jobs or redesign request context first; existing global-context isolation remains. |
| Full request buffering | Previous implementation aggregated with `request.arrayBuffer()`. | Replaced with bounded incremental reads, early body-limit rejection and shared reservations. Final contiguous transfer is still required before handler entry; this is not streaming upload. |
| Full response buffering | Ordinary responses were aggregated before transfer. | Large responses now use credit-based MessagePort transport and bounded read-ahead, with an independent response budget inside the global body budget. Small responses retain their fast path. |
| Capability HMAC/log writes | Per-dispatch capability signing and per-entry runtime log file writes remain. | TTL capability caching needs complete identity/scope/expiry keys and bounded entries. Log batching needs bounded buffering, drain and failure semantics. Neither is implemented here. |
| Tenant queue fairness | There are already per-project queues and project-aware scheduling, with a global queue-size limit. | Per-project admission quotas remain useful; this is not an entirely undifferentiated FIFO. Quotas are not added here. |
| Multiplexing/reusePort | Invocation mutates Worker globals; one server process owns routing and lifecycle state. | Concurrent invocations need context isolation first. Multi-process reusePort needs coordinated invalidation, activation and budgets; it is not a one-line safe throughput fix. |
| smol | Already enabled by default for both pools. | Preserve it. One microbenchmark does not establish equal throughput or an order-of-magnitude memory saving for allocation-heavy workloads. |

The measured 0.7 ms cannot all be labeled synchronous CPU merely by summing
elapsed file-read timings: filesystem operations are asynchronous, while parsing,
canonicalization and hashing consume CPU. A CPU profile and end-to-end benchmark
are needed to derive the server bottleneck. Even eliminating that CPU cost does
not remove the four-slot service-time bound, body transfer costs, tenant code or
GC; 20k+ RPS and 5–20x gains are unverified. With four slots, 50 ms per occupied
slot gives an idealized 80 requests/s, not a measured production result.

For runtime comparisons, use the same payloads and handler and report completed
bytes, errors, queue latency, header/completion p95/p99, CPU, RSS and cold starts.
Cloudflare isolate concurrency assumes a different request-context model;
Node-style backpressure limits buffering rather than whole-process RSS; Bun smol
and pressure-triggered `Bun.gc(true)` trade GC work for memory. Worker-side
`bun:jsc.heapStats()` and process RSS have different scopes and must not be added
together. See [memory controls and measurements](edge-function-memory.md) for
official references, raw records and the remaining slow-client RSS regression.

## Measured end-to-end result (2026-10-27)

`packages/edge-runtime/http-dispatch-benchmark.ts` (`bun run bench:http`) now
provides the end-to-end harness this review asked for. It boots the real
entrypoint against a temporary project fixture and reports completed invocations
over HTTP, so routing, JWT and throttle bookkeeping, attestation, queueing and
response delivery are all included; `bench:memory` and `bench:projects` measure
Worker-pool dispatch only.

Development host (Bun 1.4.3, macOS arm64, 4 warm Workers, 16 concurrent clients,
15 000-20 000 completed invocations, single JSON response, no I/O in the handler):

| Revision | Requests/s | p50 | p99 |
| --- | ---: | ---: | ---: |
| Before the Worker execution fixes | ~2 900 | ~5.2 ms | 7-9 ms |
| After heap-sampling/listener/version-stamp fixes | ~11 700 | ~1.1 ms | 3.1-3.9 ms |
| After throttle/keyed-proof bookkeeping fixes | ~13 800 | ~1.05 ms | 3.2-3.6 ms |

The first step was not a scheduling change. The executor called
`bun:jsc.heapStats()` on every completed execution, which walks the isolate heap
(~0.8 ms empty, ~2.8 ms with 4 MiB live) and made per-request cost grow with
tenant allocations; it is now sampled at most once per
`EDGE_WORKER_MEMORY_SAMPLE_INTERVAL_MS`. The remaining per-request CPU is spread
thin: Worker messaging (`postMessage` of the dispatch envelope), trusted-file
identity checks, response delivery and native socket work each contribute single
digit microseconds.

Against a bare `Bun.serve` route returning the same body, the function path still
costs roughly ten times more CPU per request, and the gap is the invocation model
itself (per-request Worker message, per-request trusted-file verification,
per-request environment injection) rather than one removable hotspot. Closing it
needs request multiplexing inside a Worker or a different data plane, which stays
blocked on per-request context isolation as described above.

These numbers are local and unloaded. They do not replace Linux HTTP/TLS
acceptance with production function sizes, deployment limits and tenant code.

Delivery of the implemented controls does not mark all proposed optimizations
complete. Production performance acceptance remains **PARTIAL** until Linux
HTTP/TLS tests with the reported function and deployment limits establish memory,
throughput and latency improvements together.
