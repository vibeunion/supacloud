# Function concurrency trade-offs

This follow-up corrects the proposed burst worker policy in PR #2259. Extra
workers can overlap I/O, but add independent heaps. The default ceiling remains
`WORKER_POOL_SIZE`, including Compose, so the existing memory-aware management
capacity calculation is preserved. An operator can explicitly raise
`EDGE_MAX_FUNCTION_CONCURRENCY` after measuring the deployed workload.

The previous candidate retired surplus workers immediately after each burst and
excluded those retirements from both the retirement count and lifetime churn
budgets. The revised policy retains them for one idle second, retires idle
surplus workers immediately under memory pressure, and includes every retiree in
the count budget. Surplus retirements also count toward the lifetime recycle
budget. Workers still execute only one request at a time, remain bound to one
project, and finish cancellation/waitUntil cleanup before reuse or retirement.
Growth reserves room for active, parked and not-yet-exited workers; a retiree
exit wakes queued growth without requiring all other retirees to exit first.
This limits worker count, not arbitrary allocations inside a handler.

## Local comparison

Raw output: `docs/benchmarks/edge-concurrency-review.json`. Bun 1.4.3, macOS ARM64,
30 concurrent calls, four warm workers, separate processes for each variant.
The baseline is PR #2259 rebased onto the cancellation/body-flow fixes at
`9f18cb8d01fd7bb586e9d4bbf13f1d25576a7f43`. All rows use smol workers unless noted.
The benchmark calls WorkerPool directly and consumes every response; it excludes
HTTP/TLS, authentication and dispatch attestation. These are synthetic local
measurements, not production capacity or proof that the reported 4 GiB incident
is resolved.

| Workload | Policy | RPS | p95 / p99 ms | Process CPU ms | Peak RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| 50 ms I/O, 1,200 calls | 4 slots | 72 | 415 / 420 | 1,524 | 54 |
| 50 ms I/O, 1,200 calls | Original 16-slot candidate | 208 | 145 / 150 | 13,420 | 98 |
| 50 ms I/O, 1,200 calls | Revised 16-slot candidate | 280 | 108 / 108 | 1,929 | 165 |
| 50 ms I/O, 100 ms between bursts, 300 calls | 4 slots | 59 | 416 / 421 | 437 | 53 |
| Same bursts | Original 16-slot candidate | 125 | 157 / 174 | 3,539 | 92 |
| Same bursts | Revised 16-slot candidate | 152 | 108 / 109 | 500 | 152 |
| JSON stringify/parse 300,000 items, 600 calls | 4 slots | 824 | 36 / 43 | 2,837 | 355 |
| Same JSON allocations | Original 16-slot candidate | 301 | 119 / 226 | 12,675 | 337 |
| Same JSON allocations | Revised 16-slot candidate | 1,121 | 30 / 35 | 4,066 | 1,076 |
| Same JSON allocations, smol=false | Revised 16-slot candidate | 1,200 | 27 / 31 | 4,098 | 1,130 |

For sustained I/O the original candidate created and retired 492 surplus workers
including warmup; the revision created 12 and reused them. That removes much of
the repeated startup CPU cost. Retention raises peak RSS, particularly for large
JSON allocations. In this allocation case, smol reduced peak RSS by about 5%
and throughput by about 7%; it did not reduce memory by an order of magnitude.
Keep smol enabled by default, and benchmark the actual allocation pattern before
changing it. One idle second balances reuse against retention; it is not a
promise that native RSS immediately drops after worker exit.

## Reproduce

Run each policy in a fresh process from `packages/edge-runtime` using the pinned
lockfile. For the original policy, pass `--pool-module` pointing to the baseline
checkout's `worker-pool.ts`. Use `--max-concurrency 4` for the resident-only case.

```sh
bun install --frozen-lockfile
bun worker-memory-benchmark.ts --workers 4 --max-concurrency 16 \
  --concurrency 30 --batches 40 --handler-delay-ms 50 \
  --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0

bun worker-memory-benchmark.ts --workers 4 --max-concurrency 16 \
  --concurrency 30 --batches 10 --handler-delay-ms 50 --between-batches-ms 100 \
  --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0

bun worker-memory-benchmark.ts --workers 4 --max-concurrency 16 \
  --concurrency 30 --batches 20 --json-items 300000 \
  --response-mib 0 --pause-ms 0 --delay-per-64k-ms 0
# Repeat the allocation case with --smol false for the heap-mode comparison.
```

RPS includes gaps between bursts; latency measures completion within each batch.
CPU covers the measurement phase, while worker creation/retirement counters
include warmup. The existing benchmark performs one GC before measuring, not
in the serving hot path. A Linux production acceptance still needs the real
handler, cgroup/RSS budget, HTTP/TLS, slow clients, cancellations and sustained
load; this local comparison does not justify a universal concurrency multiplier.
