# Control-plane brief outage

> Status: local serving contract
>
> Updated: 2026-11-01

This is a single-node behavior contract. It is not high availability, not
multi-node failover, and not multi-region operation. It was not deployed.
Backup RPO and backup RTO are **unmeasured**.

## SLO

While the Management API TCP listener refuses connections, these
already-running paths keep serving:

| Traffic | Serves when the Management API listener is down | Upstream |
| --- | --- | --- |
| Authenticated REST | Yes, for a project JWT. Opaque `sb_` keys and `GET /rest/v1` OpenAPI do not. | PostgREST, directly |
| Authenticated Auth | Yes, for a project JWT on `/auth/v1/*` outside `/auth/v1/admin` and admin user deletion. Opaque keys do not. | GoTrue, directly |
| Storage | Yes, when the storage data-plane process is up and can authorize the request. PostgreSQL remains the metadata store. | Management API first, then `STORAGE_DATA_PLANE_INTERNAL` (default `127.0.0.1:9108`) |
| Synchronous Functions | Yes, when Edge Runtime is an independent process and the project JWT can be verified from the tenant env file or a still-valid cache. | Management API first, then `EDGE_RUNTIME_INTERNAL` |
| Realtime | No | Management API only |

The gateway prefers the Management API for Functions and Storage so opaque-key
translation and background-task admission stay on the control plane while it
is up. Caddy retries a refused connection for every HTTP method, then skips
that upstream for 1 second (`fail_duration`). A response that the Management
API actually returns is not retried. During the outage, a background route is
executed by Edge Runtime instead of being admitted as a task.

Embedded Edge Runtime is outside this SLO. It is a child of the Management API
process, and `KillMode=control-group` stops it with `supacloud.service`. The
external unit uses `Wants=supacloud.service`, not `Requires=`, so stopping the
Management API unit does not stop that Edge Runtime process. Re-rendering the
unit is an operator step; this change was not installed on a host.

`infrastructure/systemd/supacloud-storage-data-plane.service` is the storage
process contract. It does not `Require=` the Management API. `install.sh` does
not enable it. Without that process, storage failover has nowhere to go.

## Local measurement

Command, from `packages/management-api`, on 2026-11-01:

```sh
bun test tests/unit/control-plane-outage.test.ts tests/unit/gateway.service.test.ts
```

The outage test passed and the gateway suite passed with 89 tests and 1
pre-existing skip. Caddy v2.11.7 served the routes `setupUpstream` publishes.
The Management API listener was closed until `connect` was refused (179 ms in
the 2026-11-01T01:06:49.381Z run). Ten authenticated requests then ran for each
in-scope path. PostgREST and GoTrue
were JWT-verifying stand-ins on the published dials. Their binaries were not
executed. Edge Runtime and the storage data-plane entrypoint were the real
processes.

| Path | Result in this run | Latency |
| --- | --- | --- |
| REST JWT | 10/10 succeeded | min 1 ms, p50 1 ms, max 1 ms |
| Auth JWT | 10/10 succeeded | min 1 ms, p50 1 ms, max 1 ms |
| Functions JWT | 10/10 returned `served-by-edge` | min 2 ms, p50 3 ms, max 20 ms; first success 24 ms after the listener refused connections |
| Storage data plane, direct `test_mock` list | HTTP 200, JSON array | not a PostgreSQL measurement |
| Storage through the gateway | HTTP 400 `Missing or invalid project reference` from the storage data plane, not a gateway 502 | PostgreSQL-backed storage success is **unmeasured** |
| Realtime | HTTP 502 | still requires the Management API |
| Opaque REST key | HTTP 502 | still requires the Management API |

Backup/restore RPO: **unmeasured**. Backup/restore RTO: **unmeasured**. The
24 ms figure is this workstation's dial-failover observation. It is not a
backup RTO and not a production latency promise.

## Follow-ups

These are named and not implemented here:

- primary/standby switchover
- offsite backup
- full tenant restore
- Realtime that does not enter the Management API
- enabling the storage data-plane unit from the installer
- AWS PrivateLink provider provisioning
- PostgreSQL major-upgrade executor
