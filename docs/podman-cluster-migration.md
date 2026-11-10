# Podman Single-Node to Cluster Migration

Podman is the single-node container runtime and OCI build tool. A Podman Pod is
not a cross-node scheduler and does not provide service discovery, rolling
updates, rescheduling, or persistent-volume orchestration.

Production single-node deployments use Podman Quadlet and systemd. Each
SupaCloud component retains its own container, data directory, health check and
restart boundary; a systemd target provides the one-command lifecycle surface.

Multi-node deployments use Kubernetes/OpenShift or another explicit cluster
control plane. SupaCloud should publish Helm/Kustomize resources for stateless
Management API, Edge Runtime, Worker and Realtime services, ingress/TLS,
ServiceAccounts, probes, disruption budgets, resource quotas and migration Jobs.

PostgreSQL, queues and object storage remain external HA providers or accepted
operators. Moving application containers into a cluster does not turn a local
volume into a durable database or object-store cluster.

The migration path is: validate Podman images and Quadlet on one node, push
digest-pinned images to a registry, export project configuration and recovery
metadata, deploy stateless services into an isolated namespace, restore database
and objects, run forward migrations, verify Supabase-compatible contracts and
SupaCloud receipts/audit, then switch ingress traffic.

`podman kube generate` is useful as a migration draft only. It is not a
production Helm/Kustomize replacement or evidence of database recovery.

See the [Chinese migration guide](podman-cluster-migration.zh-CN.md).
