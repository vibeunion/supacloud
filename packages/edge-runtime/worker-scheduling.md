# Worker scheduling

Workers remain permanently bound to one project. Execution slots are limited by
`WORKER_POOL_SIZE` and `BACKGROUND_WORKER_POOL_SIZE`. Idle workers for another
project can be parked, retaining module state without occupying an execution
slot. Queued projects without a slot receive the next available slot; each
project keeps FIFO request order.

Each pool independently supports these host settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `EDGE_MAX_EXTRA_PROJECT_WORKERS` | `2` | Maximum parked workers beyond the execution slots |
| `EDGE_PARKED_WORKER_IDLE_MS` | `30000` | Time before a parked worker is retired |

Either setting can be `0` to disable retention. Both settings must be non-negative
safe integers. With defaults, foreground and background pools together retain at
most four extra workers. Retiring workers remain tracked separately until exit;
existing retirement and process-recycle budgets still apply.

Memory admission closes on pressure and clears queued work and parked caches.
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
