# Read-only Application Deploy Plan

The operator needs to know whether a stored HTTP/Worker release needs activation
in a selected environment before performing any runtime effects.

`GET /v1/projects/:ref/applications/:id/environments/:environmentId/deploy-plan`
requires `release_id` and `configuration_id`. It returns candidate/current
identities, the observed activation CAS, target differences, and a migration
ledger summary. It never exposes variable values or configuration fingerprints.

The observation is not an activation approval or reusable authorization token.
Activation must still validate compatibility, migration/schema/runtime state,
worker retirement, route, readiness and CAS. The plan never allocates ports,
executes SQL, restores a database or compensates external side effects.

CLI: `app plan` remains credential-free local topology planning.
`app deploy-plan` and `app diff` observe a stored candidate in one selected
environment (`--ref`, `--id`, `--environment_id`, `--release_id`,
`--configuration_id`). Text mode shows concise differences; `--format json`
preserves the validated plan receipt.

`app deploy` automatically reads that plan, skips verified no-op, or submits one
activation using the observed CAS and a generated UUID. It never retries or
rolls back an unknown outcome. An explicit activation UUID together with expected
CAS uses the original direct activation path, including its compatibility gates,
so retries retain the original identity. A pending plan is not permission to skip
database or provisioning prerequisites. Missing/unhealthy/unverifiable plan
responses are errors, not a fallback deployment.

```gherkin
Scenario: First deployment
  Given a verified stored release and an environment-bound configuration revision
  And no active application authority
  When the operator reads a deployment plan
  Then the plan recommends activation with an absent expected activation
  And no authority, journal, configuration or runtime is written

Scenario: Verified unchanged deployment
  Given the candidate matches the active release and configuration revision
  And the successful journal, immutable artifact, resolved configuration and route match
  And readiness covers the exact activation and every runtime target
  And the stable ledger proves all declared migrations applied without provisioning prerequisites
  When the operator reads a deployment plan
  Then the plan reports no-op without replaying activation

Scenario: A deployment difference or pending prerequisite
  Given a different release or configuration, or unapplied migrations
  When the operator reads a deployment plan
  Then the plan reports activation required with explicit differences
  And application compatibility remains unproven

Scenario: Inconsistent or unhealthy observation
  Given a busy mutation, changing authority or ledger, corrupted journal or artifact,
        configuration drift, route drift or incomplete readiness
  When the operator reads a deployment plan
  Then the request fails closed with a sanitized error
  And no successful no-op is returned

Scenario: Authorization and input validation
  Given an unauthorized request or invalid scope or candidate identity
  When the request is dispatched
  Then evidence is not read
  And private provider errors and configuration fingerprints are never returned

Scenario: Automatic deployment and exact retry
  Given a verified plan with changes and an observed activation CAS
  When the operator deploys without explicit activation and CAS flags
  Then exactly one activation is submitted using the observed CAS and a stable UUID
  And an authority change is handled by the activation CAS guard
  And an unknown outcome is returned without retry or rollback
  When the operator retries with the receipt activation UUID and original CAS
  Then the original activation request is preserved without replanning
```
