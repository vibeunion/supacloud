# Preview Environment Composition

Status: **IMPLEMENTED (composition and lifecycle planning slice)**. The platform
composes a complete preview environment definition, its isolation acceptance
checks and its reclamation policy, and refuses production-shaped inputs. Actual
provisioning and teardown remain a later slice; see
[Encore Alignment Roadmap](./encore-alignment-roadmap.md).

## Why

"Preview" is a complete environment, not a renamed database branch. A pull
request needs a runnable, verifiable and reclaimable environment whose parts are
named and whose isolation is explicit. This slice defines that environment
deterministically from existing identifiers, so provisioning, verification and
reclamation all share one description.

## Endpoint

```http
POST /v1/projects/{project_ref}/previews/plan
```

The endpoint is read-only: it composes and validates; it never provisions,
connects to a database or embeds a credential.

```json
{
  "preview_ref": "pr-42",
  "application_id": "reviews",
  "environment_id": "preview",
  "release_id": "<64 hex>",
  "source": { "branch": "feature/orders", "commit": "<40 hex>" },
  "resources": { "orders-db": "project:orders" },
  "data_mode": "schema_only",
  "lifecycle": { "reclaim_on": "pr_closed_or_timeout", "timeout_hours": 168 }
}
```

## Schema

`supacloud.preview-environment.v1`:

| Field | Contents |
| --- | --- |
| `components` | database, application, configuration, resources, queues, storage, secrets — each `planned` / `ready` / `failed` / `unknown` |
| `queue_names` / `storage_buckets` | Structured preview-scoped queue and bucket names carried from the request |
| `isolation` | database role, storage permissions, consumer identity, route access control — each `pending` / `verified` / `failed` |
| `lifecycle` | `reclaim_on` (`pr_closed` / `timeout` / `pr_closed_or_timeout`), `timeout_hours` (1-720), residue policy |
| `data_mode` | `schema_only` (default) or `full_clone` |
| `source` | git branch and commit |
| `production_blocked` | Always `true` |
| `notes` | explicit non-guarantees |

The default data mode is `schema_only`, reusing the existing
[database branch and migration promotion](./database-environment-promotion.md)
mechanisms. `full_clone` requires `authorized_full_clone: true` and pre-masked
data.

`preview_ref` is a change identity (`pr-<n>` or `change-<id>`), never a branch
name; `configuration_id`, when present, is a content-addressed `cfg_…` revision
(or a legacy UUIDv4). Both grammars are enforced at composition, so the
documented and accepted forms cannot drift.

## Isolation acceptance

"Changing the prefix" is not isolation. A preview is only accepted once these
checks are `verified`:

- **database role**: the preview role must not hold cluster-management privileges;
- **storage permissions**: access is scoped to the preview binding, not the parent;
- **consumer identity**: queue consumers run under a preview-scoped identity;
- **route access control**: preview routes reject production credentials and are
  not publicly indexed.

`evaluatePreviewIsolation(preview, evidence)` turns observed evidence into the
acceptance decision. Absent evidence stays `pending` and is never treated as
verified, so a preview is `accepted` only when every check has explicit passing
evidence. The read-only endpoint composes the preview and returns the evaluation:

```http
POST /v1/projects/{project_ref}/previews/acceptance
```

```json
{
  "preview_ref": "pr-42",
  "application_id": "reviews",
  "environment_id": "preview",
  "release_id": "<64 hex>",
  "source": { "branch": "feature/orders", "commit": "<40 hex>" },
  "evidence": {
    "database_role": { "ok": true },
    "storage_permissions": { "ok": true },
    "consumer_identity": { "ok": true },
    "route_access_control": { "ok": true }
  }
}
```

## Production blocking

The composer refuses, before anything else:

- an `environment_id` or git branch shaped like `prod`, `production`, `live` or
  `release` (`PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN`);
- a resource binding whose namespace resolves to a production-shaped name;
- an inline credential or URL as a binding value
  (`PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN`). Bindings are references by
  name only (`project:orders`, `secret:orders-db`).

## Lifecycle and reclamation

Previews are reclaimed on the first trigger: the change closing or the
`timeout_hours` deadline elapsing (default `pr_closed_or_timeout`), so a missed
close webhook is still reclaimed by the timeout backstop. The pure
`previewsDueForReclamation(previews, now)` selector returns the due previews so a
reclamation worker can act on an explicit list, and `previewReclamationDue(preview, now)`
exposes the per-preview decision. The residue policy is `delete_branch_and_namespace`:
both the database branch and the queue/storage namespace are removed, so a failed
preview does not leave orphans.

## Provisioning and reclamation orchestration

`preview-provisioning.service.ts` turns a composed plan into an orchestrated run
through explicit ports, so every side effect is attributable to one component
and no credential lives in this module:

- `provisionPreviewEnvironment(ports, input)` provisions components in a fixed
dependency order (database, application, configuration, resources, queues,
storage, secrets). The first failing port stops the run, marks that component
`failed`, and skips isolation. Isolation only runs once every component is
`ready`; the result is `ready` only when all four isolation checks pass.
- `reclaimPreviewEnvironment(ports, preview)` releases every component that
  could still be live, in order: application, secrets, configuration, resources,
  then storage/queues namespaces, then the database branch. Namespace cleanup
  always runs; the auxiliary releases only run for components that were actually
  provisioned, and a provisioned component without a release port is recorded
  `unreleased` rather than assumed gone. The returned `receipt` is `reclaimed`
  only when nothing failed and nothing is `unreleased`; otherwise it is
  `incomplete`, so residue is never silently abandoned.
- `reclaimDuePreviews(ports, stored, now)` reclaims the previews whose change
  closed or whose deadline elapsed, first trigger winning.
- `createPreviewDatabasePort(branchService)` adapts the existing database branch
  service to the `database` port; the other ports are supplied by the caller.
- `createPreviewQueuePort(pgmqService)` creates and drops each preview queue as
  `preview_<ref>__<name>` (lowercase, `[^a-z0-9_]` collapsed to `_`, bounded to
  63 characters).
- `createPreviewStoragePort(storageDriver)` creates and deletes each preview
  bucket as `<preview-<ref>>-<bucket>` (lowercase, bounded to 63 characters).
- `application`, `configuration`, `resources` and `secrets` ports remain
  caller-supplied until their backends are chosen; the orchestrator fails closed
  if one is missing. Their optional release ports (`deactivate`, `unbind`,
  `revoke`) let a caller prove a provisioned component is gone; without them the
  reclamation receipt stays `incomplete` for that component.

A `ready` result is a stateful orchestration outcome, not signed provenance: it
records that the ports succeeded, not that an external system is healthy.

## Persistence and the reclamation driver

`preview-lifecycle.service.ts` persists provisioned previews through a
`PreviewStore` port and drives reclamation from stored records:

- `savePreview(store, projectRef, preview, now)` records the environment with its
  `created_at`, which the deadline selector needs.
- `markPreviewClosed(store, projectRef, previewRef, now)` records `closed_at`
  without reclaiming, so the next pass reclaims it (zero grace) while the
  absolute deadline stays a backstop if the close event is missed.
- `reclaimStoredPreviews(store, ports, projectRef, now)` lists the project's
  previews, reclaims the due ones, and removes a record **only when the receipt
  is `reclaimed`** (no failure, nothing `unreleased`), so a partial reclamation
  keeps its record and residue for the next pass.
- `closePreview(store, ports, projectRef, previewRef)` reclaims one preview by
  reference (the `pr_closed` path) and removes its record only when the receipt
  is `reclaimed`; otherwise the record and its residue remain with the receipt.
- `createProjectConfigPreviewStore(configPort)` backs the store with the project
  config under a single `previews` collection, filtering untrusted entries.

## Lifecycle routes

```http
GET    /v1/projects/{project_ref}/previews
DELETE /v1/projects/{project_ref}/previews/{preview_ref}
POST   /v1/projects/{project_ref}/previews/reclaim
```

`GET` lists tracked previews. `DELETE` reclaims one preview and removes its
record; `POST /reclaim` reclaims every due preview and returns
`{ checked, reclaimed, failed }`. Reclamation requires the cleanup ports; when
they are not configured the routes answer `501 PREVIEW_RECLAMATION_UNAVAILABLE`
instead of pretending a preview was reclaimed. This is deliberate: listing is
safe without infrastructure, but teardown must not report success it cannot
deliver.

## Boundaries

- **Composition vs provisioning.** A composed plan is not a running environment;
  it does not attest that any component exists or is healthy.
- **No production side effects.** The composer never connects to production and
  never embeds production credentials; external services default to test
  credentials by reference.
- **Fail closed.** Production-shaped or credential-bearing inputs are rejected,
  not sanitized.

## Next steps

1. Wire the remaining real cleanup ports (queue/storage namespace) and the
   remaining provisioning ports (application activation, configuration, secrets).
2. An evidence collector that fills the isolation evidence from the running
   environment so acceptance does not depend on a caller-supplied payload.
3. Persist the acceptance decision with the preview record so an accepted
   preview can be promoted without re-collecting evidence.
## Contract primitives

Deterministic, infrastructure-free primitives make Preview identity and policy
auditable before any real port is wired:

- **Naming** (`services/preview-naming.ts`): bounded, canonical slugs; per-kind
  resource names for namespace/database/queue/bucket/secret/configuration; and a
  deterministic `activation_id` via UUIDv5
  (`UUIDv5(UUIDv5(NAMESPACE_URL, "supacloud:project:<project_id>"), "preview:<preview_ref>")`),
  so retrying a provisioning step converges instead of duplicating resources.
  `preview_ref` stays `pr-<num>` / `change-<id>`; branch names and short SHAs are
  never identities.
- **Configuration** (`services/preview-configuration.service.ts`): an immutable
  `PreviewConfiguration` built only from the release contract, Preview defaults,
  and secret references. Every external service is explicitly `sandbox` or
  `disabled`. Values that look production-shaped (`prod`/`live`/`release`, or any
  URL) and unknown environment keys are rejected, not sanitized. The revision id
  is `cfg_` + base32-lower SHA-256 of the canonical JSON.
- **Secrets** (`services/preview-secrets.service.ts`): only sandbox-backed
  providers (`stripe`, `paypal`, `sendgrid`, `sentry`, `oauth`, `webhook`) may be
  enabled; anything else is refused rather than falling back to a production
  credential.
- **Authorization** (`services/preview-authorization.service.ts`): a pure role
  matrix. Members close only their own preview; `full_clone` needs an admin;
  force-deleting a non-empty bucket needs platform ops; migration promotion
  always requires approval; and `use_real_credentials` is denied for every role.

These primitives do not claim any resource exists. They are the fail-closed
contract the provisioning ports must honor once the remaining decisions in
[Preview environment open questions](./preview-environment-open-questions.md) are
confirmed.

## Readiness stages

A preview's readiness is reported as distinct, contiguous stages, never a single
"ready" flag. `evaluatePreviewStatus(preview, evidence)` returns:

- **planned** — the composed plan; nothing is asserted to exist;
- **provisioned** — every component is `ready` (no component is `failed`);
- **isolated** — provisioned *and* all four isolation checks are `verified`;
- **healthy** — isolated *and* runtime health was observed (`healthy.ok`);
- **accepted** — healthy *and* a named reviewer recorded an acceptance
  (`accepted.by` + a parseable `accepted.at`).

Each stage requires the previous one, so a healthy preview is necessarily
isolated and provisioned. The report also lists `blockers` — the unmet conditions
that prevent the next stage. `POST /v1/projects/{project_ref}/previews/acceptance`
returns this `status` alongside the isolation evaluation, so verifying isolation
never implies health or business acceptance.
