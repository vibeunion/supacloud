# Worker scheduling

Workers remain permanently bound to one project. Warm execution slots are sized
by `WORKER_POOL_SIZE` and `BACKGROUND_WORKER_POOL_SIZE`; the foreground pool may
grow beyond its warm size under queueing pressure up to
`EDGE_MAX_FUNCTION_CONCURRENCY`. Idle workers for another project can be parked,
retaining module state without occupying an execution slot. Queued projects
without a slot receive the next available slot; each project keeps FIFO request
order.

Each pool independently supports these host settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `EDGE_MAX_EXTRA_PROJECT_WORKERS` | `2` | Maximum parked workers beyond the execution slots |
| `EDGE_PARKED_WORKER_IDLE_MS` | `30000` | Time before a parked worker is retired |
| `EDGE_MAX_FUNCTION_CONCURRENCY` | `WORKER_POOL_SIZE` | Opt-in foreground ceiling on simultaneously executing invocations |

Either retention setting can be `0` to disable retention. Both settings must be
non-negative safe integers. With defaults, foreground and background pools
together retain at most four extra workers. Retiring workers remain tracked
separately until exit; existing retirement and process-recycle budgets still
apply.

A foreground request that finds no free or assignable worker is queued and then
raises the pool above its warm size, one worker per queued request, never beyond
`EDGE_MAX_FUNCTION_CONCURRENCY`. Surplus workers keep their warm state for one
idle second, then retire without a replacement. This avoids recreating workers
between nearby bursts. Expansion reserves resident capacity for outstanding
retirements and stops once the lifetime recycle budget is reached. All retirements count toward
the concurrent retirement budget; surplus retirements also count toward the
lifetime recycle budget because Bun can retain host memory after worker exit.
The default retirement count budget scales with the configured concurrency.

Memory admission closes on pressure and clears queued work and parked caches.
Idle surplus workers retire immediately; busy surplus workers retire after their
execution cleanup. They never execute a second request during cleanup or waitUntil.
Three consecutive non-growing, non-throttled samples below `memory.high` allow
limited recovery, even when idle caches plateau above the normal resume threshold.
Recovery admits at most one execution per pool and does not retain newly parked
workers. Three more stable samples restore normal admission; renewed growth or
throttling blocks it again. Sustained pressure still requests process recycling.
Foreground and background admission limits are independent, not a single
process-wide probe.

Run `bun run bench:projects` in this package to compare single-project,
cross-project, and retention-disabled workloads. It reports successful requests,
latency, throughput, module-cache hits/misses, replacements, and parked reuse.
Timings are local synthetic evidence, not production capacity guarantees.
`worker-pool.test.ts` checks deterministic cache/replacement bounds, project
environment and plugin isolation, fairness, invalidation, and worker lifecycle.
