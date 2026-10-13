# FA Deployment Capability Boundary

This document defines the product boundary for deploying Failure Analysis
(FA) through SupaCloud. Application deployment is implemented for executable
HTTP and Worker targets, but does not yet cover the complete FA Function and
schedule inventory. It is intentionally separate from the FA business
workflow. A successful deployment is not business acceptance.

## Current Implementation And Ownership

The following describes source capabilities, not a claim that a published
version or either FA environment has been upgraded.

| Concern | Current platform implementation | FA responsibility / remaining gap |
| --- | --- | --- |
| SQL RPC installation | `ApplicationMigrations` executes declared SQL through `applyRecordedMigration` | FA declares RPC bodies, RLS, grants and domain invariants in forward migrations |
| Migration ledger | Existing project migration ledger, checksums, conflict checks and read-back | No second FA ledger; legacy baseline adoption still requires verified inventory |
| Backup and migration execution | Platform lock, verified logical backup, ordered pending SQL and checksum read-back | Operator-provisioning SQL is separate; destructive SQL needs exact-plan approval |
| Deployment audit | Project mutations and platform audit record delivery operations | FA business audit and command receipts remain transactionally bound to domain writes |
| Backend deployment receipt | Orchestrator binds migration evidence to the candidate release and requires a PostgREST status probe | Health is not proof of RPC authorization or business correctness |
| Functions | Immutable staged versions and CAS-protected project Function release exist | Application delivery still lacks standalone Function targets; CLI rejects declared Edge Function targets |
| Schedules | Project schedule CRUD with revision checks exists | No desired-state convergence from an immutable application release |
| Web | Application orchestrator can bind a staged Web release by CAS | This does not make Function, schedule, SQL and Web changes one atomic transaction |

Platform ownership does not mean generating FA business rules automatically.
RPC SQL executes in the tenant database managed by SupaCloud; its definitions
stay in FA source. Deployment audit cannot replace case/report/approval audit.
Reusing the platform ledger must preserve historical checksums, not rewrite
applied migrations or infer a baseline from missing records.

The Function/schedule gaps below remain release blockers. This document and
the backend evidence checks do not implement those targets or retire the
legacy FA deployment scripts. Do not remove the legacy manifest or claim
test/production migration until a complete replacement has runtime evidence.

## Proposed Decision

When implemented, the intended public path is one project deployment command:

```sh
supacloud --env test deploy
supacloud --env production deploy --confirm-production <project-ref>
```

These are future examples, not currently supported FA deployment commands.
For supported HTTP/Worker applications the deployment resource exists; the
complete FA flow still needs the Function/schedule integration described above.

The command must submit one project deployment request and observe one
deployment receipt. The customer must not create a scope file, calculate a
scope hash, create a backup, restart PostgREST, deploy Functions one by one,
bind Web manually, or reconcile an unknown mutation by choosing a new ID.

The platform owns the deployment state machine. FA owns its source manifest,
business contracts, and product acceptance.

## Full FA Target Capability Matrix

The status in this matrix describes the complete FA path, not the absence of
the individual platform primitives listed above.

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

The application deployment resource exists at the following paths; the
complete FA inventory is not yet supported through it:

```text
POST /v1/projects/:projectRef/environments/:environmentId/deployments
GET  /v1/projects/:projectRef/environments/:environmentId/deployments/:deploymentId
POST /v1/projects/:projectRef/environments/:environmentId/deployments/:deploymentId/reconcile
```

The project-level rollback route remains a proposed part of the full FA
contract, rather than a route implemented by `project-deployments.ts`.

For the full FA contract, the request should contain an immutable source
revision and artifact manifest. The
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
