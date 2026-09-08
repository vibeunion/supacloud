# Request and background task tracing

The platform preserves W3C version-00 `traceparent` across Management API,
persisted background-function tasks, each retry, Edge execution and outbound
`fetch`. Task envelope project identity is compared against the authoritative
task row. Trace identifiers are correlation metadata, never authorization.
Legacy tasks without an envelope get a stable project/task-scoped trace.

Set `SUPACLOUD_TRACE_SAMPLE_RATE` on Management and Edge hosts (0 to 1, default
0.1). Invalid settings disable sampling. Unsampled parents remain unsampled.
The Edge host captures its setting before tenant environment injection. Each
function has at most 64 emitted outbound spans; propagation continues beyond
that limit. Async-local scopes isolate concurrent calls and close after response
consumption and `waitUntil` completion. Cached fetch references do not capture
another request's identity.

Sampled spans use `supacloud.trace-span.v1` and the existing structured log
pipeline. They contain identifiers, project, operation, status and timing only.
Bodies, tokens, URL paths/queries, arbitrary headers and error causes are never
included. Unapproved `baggage` and `tracestate` are dropped. Private task/auth
payloads remain under the existing encryption and access-control contract.

This instruments platform background-function tasks. Arbitrary PGMQ JSON and
external workflow engines keep their own payload contract; producers must
explicitly carry `traceparent`, consumers must validate their tenant binding,
and independent job attempts must create a fresh span. Do not silently wrap
existing business messages or use tracing as a second execution ledger.

## Local acceptance

```gherkin
Scenario: Retry correlation survives persisted task replay
  Given a tenant-bound trace envelope is persisted with a background task
  When the task is dispatched twice
  Then both attempts retain the trace ID and have distinct span IDs
  And the Edge child spans link to their respective attempt

Scenario: Concurrent tenants remain isolated
  Given two tenants execute concurrent asynchronous handlers
  When both issue outbound fetches
  Then each request carries its own trace and emits its authoritative project
  And a trace envelope bound to another project is rejected

Scenario: Tracing is safe under failure and delayed work
  Given requests contain secrets and delayed asynchronous work
  When a fetch fails or the request scope closes
  Then spans contain only the approved fields
  And closed scopes cannot leak identifiers into subsequent requests
```

## SLO rule installation

Load `infrastructure/monitoring/supacloud-slo.rules.yml` through the existing
Prometheus/VictoriaMetrics rule loader, verify it with `promtool check rules`,
and route its alerts to the platform on-call owner. Metrics come from the
authenticated Management `/metrics` scrape endpoint. No telemetry collector,
public port or database log table is introduced. This PR does not install rules
on a server or claim that alert delivery has been exercised there.

Background counters describe dispatched attempts, not unique jobs. Queue wait
is age since original task creation, including prior retries. Sampling affects
logs, not these counters. Silent/stalled queues with no dispatched attempts
require a separate queue inventory/dead-man alert.

## Management errors

Owner: platform on-call. Correlate the request/trace ID with the tenant and
component health. Check recent release receipts and database connectivity.
Do not retry mutations whose outcome is unknown; read their authoritative state.

## Management latency

Owner: platform on-call. Compare database saturation, runtime pool pressure and
recent changes. Inspect sampled spans without exporting tenant payloads.

## Background failures

Owner: platform on-call with application owner. Compare task attempts, runtime
status and authorization failures. Reconcile durable command receipts before
retrying a job with external side effects.

## Queue delay

Owner: platform on-call. Check worker liveness, tenant concurrency limits and
retry storms. Increase capacity only after confirming shared-resource headroom.
