# Preview Environment Composition

Status: **IMPLEMENTED (read-only planning slice)**. This slice composes a bounded
preview definition. It does not create a branch, activate code, read production
data, collect isolation evidence, persist lifecycle state or run reclamation.
See [Encore Alignment Roadmap](./encore-alignment-roadmap.md).

## Endpoint

```http
POST /v1/projects/{project_ref}/previews/plan
```

```json
{
  "preview_ref": "pr-42",
  "application_id": "reviews",
  "environment_id": "preview",
  "release_id": "<64 lowercase hex>",
  "source": { "branch": "feature/orders", "commit": "<40 lowercase hex>" },
  "resources": { "orders-db": "project:orders" },
  "data_mode": "schema_only",
  "lifecycle": { "reclaim_on": "pr_closed", "timeout_hours": 168 }
}
```

The route first requires project or administrator authentication. A `full_clone`
plan additionally requires a verified platform `admin` or `master` principal.
The legacy `authorized_full_clone` request field is ignored as an authorization
source: setting it to true cannot grant permission. The internal composer takes
a trusted policy result, not an unverified HTTP assertion. Even an authorized
plan is not execution approval or proof that a source dataset is pre-masked;
those checks must occur independently when provisioning is implemented.

## Contract

`supacloud.preview-environment.v1` contains database, application, configuration,
resources, queues, storage and secrets components. All start `planned`. The four
isolation checks (database role, storage permissions, consumer identity and route
access control) all start `pending`; none is treated as observed or verified.

`configuration_id` retains the selected UUID revision or null. `resource_bindings`
retains a detached map of logical resource names to opaque references. A later
adapter must consume these structured fields, never parse human-readable component
`detail` strings. Resource references and configuration identity remain unverified.

`branch_ref` is a deterministic 20-character identifier: `pv` plus 18 SHA-256 hex
characters over a domain-separated tuple of the exact project and preview IDs.
Case and separator differences are not collapsed. The digest fits existing tenant
reference limits. Neither a digest nor a name prefix proves ownership: a future
provisioner must reject collisions and verify stored project/preview ownership
before reusing or deleting anything. This replaces the old project-independent
`preview-<ref>` naming rule; no infrastructure is migrated by this planning slice.

## Input boundaries

Identifiers and references require full-string matches; trailing control characters
are rejected. `resources` allows at most 64 names and references. Formatted output,
including structured references and display details, is limited to 64 KiB UTF-8.
Invalid data-mode values, non-string references and malformed lifecycle values fail
with stable errors rather than exposing rejected input.

Production-shaped environment names, branch path segments and binding destinations
are rejected. URL or credential-shaped binding values are rejected. These are
syntax policies, not proof that arbitrary external resources are non-production.
`production_blocked: true` describes the applied name policy only; execution must
resolve and authorize every target independently. Do not encode secrets in names.

## Lifecycle planning

The default is `pr_closed`; `timeout` accepts an integer from 1 to 720 hours.
`previewsDueForReclamation(previews, now)` is a pure selector. Invalid ages or
out-of-range deadlines are never selected as permission to delete. No worker is
installed here, and neither selector output nor the `delete_branch_and_namespace`
residue policy claims that cleanup has happened.

## Next implementation boundaries

Provisioning requires independent credentials, resource ownership, quarantine until
isolation passes, and a durable record before side effects. Reclamation needs a
complete cleanup receipt, per-generation concurrency protection and verified
ownership. Storage and external data recovery remain separate from application
rollback. These requirements are not satisfied by the plan alone.
