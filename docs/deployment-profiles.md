# SupaCloud Deployment Profiles

SupaCloud supports a simple installation experience while keeping PostgreSQL,
Supabase-compatible contracts, and component-level operational boundaries.

The supported profiles are:

| Profile | Use | Database | Runtime |
| --- | --- | --- | --- |
| `solo` | Small single-node deployments | Podman-managed local PostgreSQL; external databases use the external/Pigsty provider | Podman Quadlet + systemd |
| `podman` | Explicit `solo` runtime entry | Podman-managed local PostgreSQL; external database units are not yet accepted | Podman Quadlet + systemd |
| `pigsty` | Enterprise self-hosting and HA | Pigsty/Patroni PostgreSQL | systemd/Pigsty |
| `cluster` | Multi-node deployments | External HA PostgreSQL or an accepted operator | Kubernetes/OpenShift or another cluster control plane |

An external database must be selected explicitly. The installer never adopts an
unknown local PostgreSQL process merely because port 5432 is open.

The installation plan fixes component versions, providers, secrets, migrations,
health checks and recovery metadata. `setup.sh` is only the verified bootstrap;
the Admin installer reconciles the plan and preserves evidence for failed or
unknown stages.

Operator input is intentionally conditional. `solo` derives component ports,
internal URLs, service paths, Studio origin and generated keys. An external
database requires an explicit database URL, and external object storage
requires its own endpoint and credentials; unused provider settings are not
requested. Generated `install.env` and `management-api.env` files are runtime
artifacts, while the onboarding plan remains the operator-facing input.

The `solo` and `podman` profiles share the same project, identity, migration,
Storage, Realtime and Management API contracts. Lite remains a separate
single-project local-first runtime and is not evidence of Full Platform
production readiness.

The Podman path is a single-node deployment. Production uses Quadlet and systemd;
`podman compose` is only a migration/development convenience and is not the
authoritative production format. A successful Podman start or health check does
not by itself prove production recovery.

Any historical `docker/` build or migration fixtures retained in the repository
are not supported installation entrypoints. New installations do not install
Docker, Docker Compose, or the `podman-docker` compatibility layer.

Podman Pods do not provide cross-node scheduling, service discovery, rolling
updates or persistent-volume orchestration. Cluster deployments should use
Kubernetes/OpenShift (or another explicit cluster control plane); SupaCloud can
publish Helm/Kustomize resources while keeping PostgreSQL and object storage under
their own HA providers.

See the [Chinese deployment profile guide](deployment-profiles.zh-CN.md) for the
provider boundaries, migration alternatives and acceptance scenarios.
