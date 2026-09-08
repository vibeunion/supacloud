# Multi-function release units

## Acceptance contract

```gherkin
Scenario: All candidates are ready before a generation is visible
  Given two immutable function versions and the expected project release ID
  When either foreground or background preheat fails
  Then the active project manifest is unchanged

Scenario: One publication wins a concurrent compare-and-swap
  Given two publishers use the same expected release ID
  When both publish
  Then exactly one replaces the project authority
  And the other receives a conflict without changing any member

Scenario: Interruption and lost responses do not repeat a publication
  Given a durable mutation and immutable release generation
  When the process stops before or after the authority rename
  Then status identifies the current authoritative release
  And replay with the same mutation reads back or resumes that generation

Scenario: A release cannot be bypassed with individual activation
  Given functions belong to an active release unit
  When a single-function deploy, config update, activation or delete is requested
  Then it is rejected and staging a new immutable version remains available
```

The release authority is a single fsync-backed `.project-release.json` rename.
It references immutable function versions and includes the complete previously
enrolled member set. Additional functions can be enrolled. Removing enrolled
members is not supported. Use a new release containing previous versions to
roll back; do not edit history or remove the authority file.

Requests resolved before a switch may finish on their selected immutable
version. A request racing the final authority check may fail with the existing
runtime-changed response. Separate HTTP requests are not a cross-request
transaction. Pinned background tasks retain their original immutable version.
Runtime restart reloads the durable authority, not a memory-only switch.

Preheat runs for every immutable candidate in both runtime pools before
publication. It validates the existing artifact/environment attestation.
It does not promise that every subsequent worker is hot: eviction, scaling,
runtime restart and the new activation cache identity can require re-import.
Function module initialization must be side-effect free, as for existing preheat.

This is opt-in for a shared trusted functions filesystem, not a distributed
transaction across independent runtime hosts or filesystems. Deploy a runtime
supporting the manifest before using the API. Old runtimes are rejected by
the release-capability check. No database, queue or external side effect is
made atomic by this mechanism.

## API

Authenticated project/admin APIs:

- `POST /v1/projects/:ref/functions/:slug/stage`: `{code, config?}` returns
  `version` and `artifact_sha256` without changing the active version.
- `GET /v1/projects/:ref/function-releases`: active ID, generation and members.
- `POST /v1/projects/:ref/function-releases`: `{mutation_id,
  expected_release_id, functions:[{slug,version,expected_activation_id}]}`.
  Use null for the first expected release ID; per-member IDs come from the
  existing function state API. All previously enrolled members are required.
- `GET /v1/projects/:ref/function-releases/:mutationId`: active authority and
  durable mutation status. A lost response is not a reason for a new ID.

After an interrupted unpublished preparation, resubmit the exact same request
and mutation ID after its lease expires (maximum one hour). After publication
with an unknown receipt, the same request confirms disk durability and
reconciles the receipt without repeating publication. No background retry loop
automatically publishes a release. Unresolved mutations block other release
mutations for the project.
