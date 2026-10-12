# FA Deployment Capability Boundary

This document is a proposed product boundary for deploying Failure Analysis
(FA) through SupaCloud. The project-scoped deployment contract described here
is not implemented by the current CLI or Management API. It is intentionally
separate from the FA business workflow. A successful deployment is not
business acceptance.

## Proposed Decision

When implemented, the intended public path is one project deployment command:

```sh
supacloud --env test deploy
supacloud --env production deploy --confirm-production <project-ref>
```

These are future examples, not currently supported FA deployment commands.
Until the project deployment contract lands, use the existing target-level
deploy flow documented in `docs/cli-guide.md`.

The command must submit one project deployment request and observe one
deployment receipt. The customer must not create a scope file, calculate a
scope hash, create a backup, restart PostgREST, deploy Functions one by one,
bind Web manually, or reconcile an unknown mutation by choosing a new ID.

The platform owns the deployment state machine. FA owns its source manifest,
business contracts, and product acceptance.

## Target Capability Matrix

| Capability | Target state | Owner | Customer-visible contract |
| --- | --- | --- | --- |
| Project/environment identity | Planned | SupaCloud | `--env` selects a profile; production requires the exact project ref |
| Artifact build and upload | Planned | CLI + SupaCloud | The CLI reports `Preparing` and `Building`; the platform stores immutable artifacts |
| Migration plan, compatibility and pending checks | Planned | SupaCloud | A summarized `Database` phase; no migration inventory or SQL allowlist is required |
| Logical backup before a migration | Planned | SupaCloud | A backup reference in the receipt only |
| Seven FA Functions and CAS activation | Planned | SupaCloud | One `Functions` phase and one project receipt |
| Schedule convergence | Planned | SupaCloud | Desired state comes from the versioned FA manifest |
| Runtime secret names and secret writes | Planned | SupaCloud | Values never appear in the receipt or CLI output |
| Immutable Web release and activation | Planned | SupaCloud | One `Web` phase bound to the same deployment receipt |
| PostgREST refresh and health/read-back | Planned | SupaCloud | One `Verifying` phase |
| Idempotency and unknown-outcome recovery | Planned | SupaCloud | Re-running the same command observes the same deployment ID |
| Rollback of code/Web activation | Planned | SupaCloud | `supacloud rollback` selects a platform-verified previous release |
| FA login, tenant/RBAC, case/report/approval workflows | Keep | FA | Product features and authenticated business acceptance stay in FA |
| Evidence, report, audit, checksum and authorization rules | Keep | FA + database | Immutable business truth remains in FA tables/RPCs |
| OCR, provider adapter and worker lease/retry/DLQ behavior | Keep | FA | Deploying the runtime must not change business semantics |
| S3 provider migration and lifecycle checks | Conditional | FA infrastructure | Run only for storage setup/provider migration, never for code deploy |
| QNAP/SMB provisioning and ACL repair | Conditional | FA infrastructure | Run as an explicit storage task when the change affects that path |
| PKCE/browser canary | Conditional | FA acceptance | Run for Auth/OAuth/access-context changes, not every deployment |
| Full browser business-flow acceptance | Keep separate | FA | Required after deployment for the affected workflow, not a deployment preflight |

## Retire From The Customer Path

The following remain available only as internal diagnostics or historical
receipt readers. They must not be required by FA documentation or normal
release scripts:

- hand-authored scope JSON and `scope_create`;
- `scope_rebind` and `scope_inspect`;
- manually supplied scope hashes or controller commits;
- separate `--preflight` and `--apply` release-controller invocations;
- manually chained migration, Function, Web and receipt commands;
- customer-selected backup IDs or PostgREST restart commands;
- customer-side `OUTCOME_UNKNOWN` interpretation;
- browser PKCE, anonymous table probes and S3 lifecycle smoke on every deploy;
- long-lived FA-side copies of old Web archives when the platform retains an
  immutable release and rollback authority.

Legacy readers may remain until all old receipts have aged out. New writes
must use the single SupaCloud project deployment receipt contract.

## Proposed Project Deployment Contract

A future platform implementation should expose one project-scoped deployment
resource:

```text
POST /v1/projects/:projectRef/environments/:environmentId/deployments
GET  /v1/projects/:projectRef/environments/:environmentId/deployments/:deploymentId
POST /v1/projects/:projectRef/environments/:environmentId/deployments/:deploymentId/reconcile
POST /v1/projects/:projectRef/environments/:environmentId/rollback
```

The request contains an immutable source revision and artifact manifest. The
platform derives the effective migration, Function, schedule, secret and Web
changes from that manifest. The public response contains:

- `deployment_id`;
- current phase and phase timestamps;
- `status`: `planned`, `running`, `succeeded`, `failed` or `reconciliation_required`;
- backend, Function and Web receipt references;
- rollback authority when a previous activation exists.

The request is idempotent by `(project_ref, environment_id, deployment_id)`.
No client retry may create a second migration, backup, Function activation or
Web activation.

## FA Feature Investment

### Implement and keep

- the FA domain model and all user-facing workflows;
- database governance, RLS, RPC boundaries and audit/checksum controls;
- the seven runtime Functions, scheduled worker and durable worker controls;
- private artifact storage, OCR/provider adapters and report generation;
- authenticated acceptance for the affected business workflow.

### Do not expand

- another FA-specific deployment engine;
- another receipt schema for new writes;
- another scope format;
- per-deploy storage migration or browser-canary gates;
- customer-facing database restore and infrastructure repair commands.

### Explicitly abandon as primary paths

- `fa-supacloud-scoped-release.ts`;
- `fa-generic-scoped-release.ts`;
- `fa-prepare-release-scope.ts`;
- `fa-supacloud-web.ts`;
- `fa-supacloud-code-only-resume.ts`;
- public `fa:standalone:*` release scripts.

They may be retained temporarily as migration adapters or read-only
diagnostics, but new FA documentation must not teach them.

## Future Acceptance

This boundary will be complete only when a clean FA checkout can run:

```sh
supacloud --env test deploy
```

with no scope file or release script and receives one deployment ID. A second
invocation after a lost response must reconcile that same ID. A code-only
change must skip database mutation and backup while still verifying Function
identity and startup health. A migration change must perform the platform-owned
plan, backup, migration, read-back and Web binding without exposing those
internal steps as customer instructions.
