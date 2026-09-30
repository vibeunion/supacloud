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

## Boundaries

- **Composition vs provisioning.** A composed plan is not a running environment;
  it does not attest that any component exists or is healthy.
- **No production side effects.** The composer never connects to production and
  never embeds production credentials; external services default to test
  credentials by reference.
- **Fail closed.** Production-shaped or credential-bearing inputs are rejected,
  not sanitized.

## Next steps

1. A provisioning orchestrator that creates the branch, activates the release,
   binds resources and records per-component status.
2. An isolation verifier that flips the acceptance checks to `verified`.
3. A reclamation worker driven by `previewsDueForReclamation`.