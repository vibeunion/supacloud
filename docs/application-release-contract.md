# Application release contract

Status: **IMPLEMENTED (read-only plan slice)**. The contract and local plan are
available. Applying the plan still uses the existing reviewed release surfaces:
migrations, atomic Function releases, immutable Application releases, and
immutable frontend activation. There is no generic `release apply` that replays
all four mutations in one request.

The contract turns a release from an informal sequence of CLI calls into one
immutable, hash-bound document. Downstream release controllers can validate the
same document before they mutate a project, and can store the canonical
`scope_sha256` beside their receipt.

## Schema

The canonical schema is `supacloud.release-control.v2`, exported by
`@supacloud/delivery/release-contract`. The management API keeps its previous
import path as a compatibility re-export.

```json
{
  "schema": "supacloud.release-control.v2",
  "releaseId": "fa-release-20261027",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "targetProjectRef": "vxmnblbzsxzutzrjntyu",
  "targetEnvironmentId": "production",
  "components": [
    { "kind": "function", "slug": "fa-api", "artifactSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { "kind": "migration", "name": "20261027060000_issue_5619" },
    { "kind": "web", "artifactSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
  ]
}
```

Rules enforced by the parser:

- exact top-level and component fields; unknown fields fail closed;
- a 40-character lowercase source commit and a concrete target environment;
- unique components sorted by kind and identity;
- lowercase SHA-256 for every Function and Web artifact;
- migration names in `YYYYMMDDHHMMSS_intent` form.

The contract describes **intent**, not proof of deployment. It does not embed
credentials, environment profiles, backup IDs, rollback URLs, or mutable
read-back state.

## Read-only plan

```bash
supacloud release contract_plan \
  --file supacloud.release.json \
  --ref "$PROJECT_REF" \
  --environment_id production \
  --require_current_source
```

The command is classified as `local`: it reads one file and Git metadata and
performs no HTTP request or mutation. It:

1. parses the contract with the shared strict parser;
2. rejects a contract bound to another project or environment;
3. computes the canonical `scope_sha256`;
4. reports component counts and whether the source commit matches `HEAD` and
   `origin/main`;
5. with `--require_current_source`, fails unless `sourceCommit` equals `HEAD`.

The output is `supacloud.cli.release-control.v1` with
`plan_schema: "supacloud.release-plan.v1"`, `read_only: true`, and
`mutations_performed: false`.

Example receipt excerpt:

```json
{
  "schema": "supacloud.cli.release-control.v1",
  "ok": true,
  "operation": "release.contract_plan",
  "plan_schema": "supacloud.release-plan.v1",
  "release_id": "fa-release-20261027",
  "scope_sha256": "<64-lowercase-hex>",
  "component_counts": { "migration": 1, "function": 1, "web": 1 },
  "checks": {
    "source_commit_matches_head": true,
    "source_commit_matches_origin_main": true,
    "target_project_ref_matches_requested": true,
    "target_environment_id_matches_requested": true,
    "components_unique_and_sorted": true
  },
  "read_only": true,
  "mutations_performed": false
}
```

## Applying a planned release

The plan is deliberately separate from execution. Use the surface that owns each
component and keep the same immutable identities:

| Component | Existing reviewed surface |
| --- | --- |
| Migrations | `database push_migrations` or the application migration archive |
| Functions | `POST /v1/projects/:ref/function-releases` after staging immutable versions |
| Application backend | `applications deploy_release` with the reviewed configuration revision |
| Web assets | `deploy` or `frontend` immutable release activation |

A release controller must stop on an unknown mutation outcome and reconcile the
same mutation identity. It must not re-plan with refreshed compare-and-swap
values and silently retry. Database, Function, Application, and frontend
rollbacks remain separate recovery paths; this contract does not claim one
rollback switch.

## Acceptance contract

```gherkin
Scenario: A plan cannot silently target another project
  Given a valid release contract for project A
  When the operator requests a plan for project B
  Then the command fails before any HTTP request
  And no mutation identity is created

Scenario: A stale source contract is visible
  Given a release contract whose sourceCommit differs from HEAD
  When the operator requests a plan without --require_current_source
  Then the plan reports source_is_current=false
  And it remains read-only

Scenario: A release controller requires the current checkout
  Given a release contract whose sourceCommit differs from HEAD
  When the operator requests a plan with --require_current_source
  Then the command fails closed
```

## Boundaries

- The plan does not fetch remote state or prove that a component is absent,
  current, or healthy.
- The contract does not include secrets, backup proof, or rollback readiness.
- A valid plan is not an approval. Production writes still require the existing
  project-scoped authorization, environment profiles, and `--confirm-production`
  behavior.
- `sourceCommit`, artifact hashes, and `releaseId` must remain immutable once a
  controller stores a receipt. Create a new contract for a new release.
