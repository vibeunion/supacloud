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
  "lifecycle": { "reclaim_on": "pr_closed", "timeout_hours": 168 }
}
```

## Schema

`supacloud.preview-environment.v1`:

| Field | Contents |
| --- | --- |
| `components` | database, application, configuration, resources, queues, storage, secrets — each `planned` / `ready` / `failed` / `unknown` |
| `isolation` | database role, storage permissions, consumer identity, route access control — each `pending` / `verified` / `failed` |
| `lifecycle` | `reclaim_on` (`pr_closed` / `timeout`), `timeout_hours` (1-720), residue policy |
| `data_mode` | `schema_only` (default) or `full_clone` |
| `source` | git branch and commit |
| `production_blocked` | Always `true` |
| `notes` | explicit non-guarantees |

The default data mode is `schema_only`, reusing the existing
[database branch and migration promotion](./database-environment-promotion.md)
mechanisms. `full_clone` requires `authorized_full_clone: true` and pre-masked
data.

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

Previews are reclaimed on `pr_closed` or after `timeout_hours`. The pure
`previewsDueForReclamation(previews, now)` selector returns only overdue
timeout-based previews, so a reclamation worker can act on an explicit list. The
residue policy is `delete_branch_and_namespace`: both the database branch and the
queue/storage namespace are removed, so a failed preview does not leave orphans.

## Provisioning and reclamation orchestration

`preview-provisioning.service.ts` turns a composed plan into an orchestrated run
through explicit ports, so every side effect is attributable to one component
and no credential lives in this module:

- `provisionPreviewEnvironment(ports, input)` provisions components in a fixed
dependency order (database, application, configuration, resources, queues,
storage, secrets). The first failing port stops the run, marks that component
`failed`, and skips isolation. Isolation only runs once every component is
`ready`; the result is `ready` only when all four isolation checks pass.
- `reclaimPreviewEnvironment(ports, preview)` releases namespace components first
  (storage, queues) and the database branch last, continues after a failure, and
  reports exactly which releases failed so residue is never silently abandoned.
- `reclaimDuePreviews(ports, stored, now)` reclaims only timeout-due previews,
  leaving `pr_closed` previews to their webhook.
- `createPreviewDatabasePort(branchService)` adapts the existing database branch
  service to the `database` port; the other ports are supplied by the caller.

A `ready` result is a stateful orchestration outcome, not signed provenance: it
records that the ports succeeded, not that an external system is healthy.

## Persistence and the reclamation driver

`preview-lifecycle.service.ts` persists provisioned previews through a
`PreviewStore` port and drives reclamation from stored records:

- `savePreview(store, projectRef, preview, now)` records the environment with its
  `created_at`, which the timeout selector needs.
- `reclaimStoredPreviews(store, ports, projectRef, now)` lists the project's
  previews, reclaims only the timeout-due ones, and removes a record **only when
  every release succeeds**, so a failed reclamation keeps its record and residue
  for the next pass.
- `closePreview(store, ports, projectRef, previewRef)` reclaims one preview by
  reference (the `pr_closed` path) and removes its record on full success.
- `createProjectConfigPreviewStore(configPort)` backs the store with the project
  config under a single `previews` collection, filtering untrusted entries.

## Boundaries

- **Composition vs provisioning.** A composed plan is not a running environment;
  it does not attest that any component exists or is healthy.
- **No production side effects.** The composer never connects to production and
  never embeds production credentials; external services default to test
  credentials by reference.
- **Fail closed.** Production-shaped or credential-bearing inputs are rejected,
  not sanitized.

## Next steps

1. Wire the remaining real ports (application activation, configuration,
   queue/storage namespace, secrets) and an evidence collector that fills the
   isolation evidence from the running environment.
2. Expose preview lifecycle routes (create/list/close) over the store and the
   port-driven orchestration.
3. Persist the acceptance decision with the preview record so an accepted
   preview can be promoted without re-collecting evidence.