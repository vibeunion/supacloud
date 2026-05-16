# PostgREST Runtime Lifecycle

SupaCloud keeps the current per-project PostgREST model, but treats each PostgREST process as a managed runtime component instead of an unmanaged side effect of project provisioning.

This keeps request-path performance unchanged:

- provisioning still starts PostgREST immediately after project creation
- active projects are not idle-paused automatically
- only explicit operator actions, project pause/delete cleanup, and background reconciliation stop or repair units

## State Model

PostgREST desired and observed state is stored as dedicated metadata columns on the project record, not inside the JSON project config:

| Column | Example |
|--------|---------|
| `postgrest_desired` | `running` |
| `postgrest_actual` | `running` |
| `postgrest_health` | `healthy` |
| `postgrest_port` | `3101` |
| `postgrest_last_error` | `null` |
| `postgrest_updated_at` | `2026-05-16T00:00:00.000Z` |
| `postgrest_last_reconciled_at` | `2026-05-16T00:00:00.000Z` |

Valid desired states:

| Value | Meaning |
|-------|---------|
| `running` | PostgREST should be enabled, started, and healthy for the project |
| `stopped` | PostgREST should be stopped and disabled for the project |

If no explicit desired state exists, active projects default to `running`; inactive, paused, deleted, or failed projects default to `stopped`.

Observed fields are best-effort operational telemetry:

| Field | Meaning |
|-------|---------|
| `actual` | `running`, `starting`, `stopped`, or `error` |
| `health` | HTTP probe result: `healthy`, `unhealthy`, or `unknown` |
| `port` | resolved tenant PostgREST port |
| `last_error` | most recent PostgREST-only control/probe error |
| `last_reconciled_at` | last background reconcile write |

## Management API

PostgREST can be controlled without touching GoTrue or other project services:

| Method | Endpoint | Effect |
|--------|----------|--------|
| `GET` | `/v1/projects/:ref/services/postgrest/status` | Read desired state, actual state, health, port, unit, and last error |
| `POST` | `/v1/projects/:ref/services/postgrest/start` | Set desired `running` and start or repair PostgREST |
| `POST` | `/v1/projects/:ref/services/postgrest/stop` | Set desired `stopped` and stop/disable PostgREST |
| `POST` | `/v1/projects/:ref/services/postgrest/restart` | Set desired `running` and restart PostgREST |
| `POST` | `/v1/projects/:ref/services/postgrest/pause` | Alias of stop |
| `POST` | `/v1/projects/:ref/services/postgrest/resume` | Alias of start |
| `POST` | `/v1/projects/:ref/services/postgrest/status` | Action-style status read for service-control clients |

`rest` is accepted as a compatibility alias for `postgrest` in the service-control route.

`GET /v1/projects/:ref/services` and `GET /v1/projects/:ref` include PostgREST observability fields alongside the existing Supabase Studio-compatible service status shape.

## Reconciliation

The runtime reconcile worker periodically compares desired state with systemd actual state:

- project missing from metadata but a `supacloud-pgrst@*` unit exists: stop runtime cleanup
- project status is not active/creating: stop project runtime
- desired `stopped` but PostgREST is running: stop only PostgREST
- desired `running` and project is active but PostgREST is unhealthy or stopped: prepare config and repair/start PostgREST
- no drift: refresh observation fields and `last_reconciled_at`

The worker does not implement idle auto-shrink. That is intentional for the first version because it avoids request-path cold starts and avoids per-tenant access-time tracking complexity.

## Systemd Units

PostgREST remains one physical systemd unit per project:

```bash
systemctl status supacloud-pgrst@<project_ref>
```

GoTrue is intentionally separate:

```bash
systemctl status supacloud-gotrue@<project_ref>
```

PostgREST-only pause/resume/restart does not stop or restart GoTrue.

## Operational Guidance

Use PostgREST-only controls when:

- a project REST endpoint is unhealthy but Auth is healthy
- you changed PostgREST config and do not need to restart GoTrue
- a paused/deleted/failed project left a stale PostgREST unit behind
- you need status/error evidence before deciding whether to restart the whole project runtime

Use full project runtime controls when:

- both PostgREST and GoTrue need regenerated config
- project provisioning, restore, or OAuth/OIDC migration changed shared runtime credentials
- you are cleaning up an entire project
