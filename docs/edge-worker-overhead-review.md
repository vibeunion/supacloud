# Worker execution overhead review

PR #2261 samples worker heaps at execution completion instead of walking the
heap after every request. The default interval is 250 ms; zero preserves
per-execution sampling. Preheat always samples immediately. Module lifetime
budgets still update after every execution. A sample is not a hard heap limit:
an idle worker may retain an outdated sample until another execution completes.

The pool routes execution and preheat events through one lifecycle owner per
worker. Preheat errors and exits settle once, retire the worker, and ignore late
success messages. An idle error replaces the affected worker. Response headers
receive the runtime-owned function version during construction, preserving
tenant-header removal and error/stream behavior without a second Response.
Temporary phase-tracing hooks were removed from the serving path.

## Local measurements

Raw records: [edge-worker-overhead-review.json](benchmarks/edge-worker-overhead-review.json).
Bun 1.4.3 on macOS ARM64, 30 concurrent clients, four smol workers, separate
sequential processes for each policy. Baseline includes the reviewed #2258 and
#2259 changes. These are single synthetic runs, not production capacity or proof
that the reported 4 GiB incident is fixed. HTTP/TLS, authentication and server
dispatch attestation are excluded.

| Workload | RPS before / after | p95 / p99 before, ms | p95 / p99 after, ms | CPU before / after, ms | Peak RSS before / after, MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| One-byte response, 60,000 calls | 2,997 / 40,000 | 10 / 11 | 1 / 2 | 78,596 / 5,417 | 157 / 171 |
| 1 ms handler delay, 3,000 calls | 1,473 / 2,368 | 20 / 24 | 13 / 15 | 4,234 / 1,218 | 144 / 128 |
| JSON stringify/parse 300,000 items, 600 calls | 846 / 1,024 | 35 / 37 | 29 / 30 | 2,844 / 2,358 | 365 / 353 |
| 8 MiB response, slow consumers, 60 calls | 71 / 71 | 434 / 434 | 427 / 427 | 371 / 360 | 599 / 567 |
| Same slow consumers, 1,800 calls | 72 / 74 | 427 / 431 | 421 / 426 | 9,731 / 6,964 | 829 / 811 |

The short-response measurement spans several sampling intervals even in the
faster candidate. Reduced inspection cost helps short handlers most; it cannot
remove handler I/O or client backpressure. The short-response RSS increase is a
trade-off, not a memory reduction claim. Each run completed without worker
replacement; the slow-consumer runs consumed 480 MiB and 14,400 MiB respectively.
The longer comparison lasted about 25 seconds per policy; it does not establish
long-term leak freedom. Candidate body and response
reservations returned to zero. A logical buffer reservation is not process RSS.

## Reproduce

From `packages/edge-runtime`, run the same arguments in separate processes with
and without `--pool-module /path/to/baseline/packages/edge-runtime/worker-pool.ts`.
Use the pinned dependencies and runtime version.

```sh
bun worker-memory-benchmark.ts --workers 4 --max-concurrency 4 --concurrency 30 \
  --batches 2000 --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0
bun worker-memory-benchmark.ts --workers 4 --max-concurrency 4 --concurrency 30 \
  --batches 100 --handler-delay-ms 1 --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0
bun worker-memory-benchmark.ts --workers 4 --max-concurrency 4 --concurrency 30 \
  --batches 20 --json-items 300000 --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0
bun worker-memory-benchmark.ts --workers 4 --max-concurrency 4 --concurrency 30 --batches 2
# Repeat with --batches 60 for the longer slow-consumer comparison.
```

Validation: 355 passing Edge Runtime tests, 22 platform skips on macOS; typecheck
and compiled macOS ARM64 build passed. The stress fixture now waits for execution
and response cleanup before checking idle capacity, retaining the existing
retirement assertions. Both stress cases passed separately after this adjustment.
Linux CI and the deployed workload remain separate acceptance evidence.
