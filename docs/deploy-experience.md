# Deployment Experience

The CLI owns local build and presentation; Management owns immutable artifacts,
active authority, CAS, compatibility, mutation receipts and recovery. Applications
declare business schema, RLS, OAuth bindings and acceptance checks.

## Read-Only Comparison

```bash
supacloud --env staging deploy --dry_run
supacloud --env staging deploy --plan --json
supacloud --env staging deploy --diff --skip_build --json
```

`dry_run` resolves the target without building. Frontend `plan` and `diff` run the
configured local build unless `skip_build` is set, package a temporary immutable
archive, and compare it with the platform's current authority. They perform only
remote GETs and delete the temporary archive. Builds are trusted local project
commands, not sandboxed code. The comparison is release-level, not a source-code
or per-file patch. It includes environment, both hashes, bytes, files, expected
CAS and prospective upload/activation actions. Never apply a saved plan without
reobserving authority; a plan is evidence, not a reusable write token.

Existing `deploy` behavior is preserved: without planning flags it publishes,
subject to read-only mode and exact production confirmation. `plan`/`diff` cannot
be combined with `dry_run`. Edge Function `plan` is resolution-only; multi-Function
release comparison requires an immutable version manifest.

Content-equivalent frontend trees skip upload and activation even if archive hashes
differ. Current integrity gates and exact post-activation readback remain.
Unknown activation results retain mutation ID, target release and original CAS;
inspect durable mutation status instead of retrying a write.

## One-Command Application Release

For the normal application path, the CLI provides one profile-backed release
workflow:

```bash
supacloud --env test deploy
supacloud --env production deploy --confirm-production production-ref
```

Declare the Application once in `supacloud.json`:

```json
{
  "application": { "id": "orders" }
}
```

The selected `.env.supacloud.<name>` supplies the project credentials and
`SUPACLOUD_ENV`; the selected environment overrides the optional repository
`application.environmentId`. An explicit `SUPACLOUD_APPLICATION_ID` profile
continues to select its own `SUPACLOUD_APPLICATION_ENVIRONMENT_ID` (or
`SUPACLOUD_ENV`). Configuration is resolved from the platform unless a
configuration path or immutable revision is explicitly declared. `deploy`
uses the project deployment resource for this Application path. Test and
production use the same command shape. The explicit advanced form remains available:

```bash
supacloud --env test app release \
  --id orders --environment_id test --configuration_path configuration.json
```

`app release` builds the local delivery manifest and uploads the immutable
release, then submits one project deployment mutation. SupaCloud owns the
deployment plan, backup, migration, runtime readiness, Web binding and CAS
activation behind that mutation. Use
`--configuration_id <uuid> --skip_build --manifest_path <path>` when reusing an
already reviewed configuration and manifest. `--format json` returns one receipt
containing every completed phase, the release/configuration identities and the
activation result.

The workflow stops on the first failed or uncertain phase. A lost or malformed
deployment response triggers a bounded GET for the same deployment ID. Only a
verified terminal receipt matching the project, environment, application,
candidate, configuration, backend and requested Web release confirms success.
The CLI never rewrites a foreign receipt's identity or sends a second deployment
POST. A nonterminal or unavailable status remains unknown and retains the
deployment ID. This is receipt confirmation, not resumption after a server crash.
The composed CLI workflow is not a cross-request
transaction; SupaCloud remains responsible for immutable storage, backup policy,
migration orchestration, readiness, smoke evidence, CAS authority, durable
mutation receipts and verified rollback/downgrade policy. The application layer
does not implement backup, restore, activation or downgrade orchestration.

## Current Project Boundary

The project endpoint currently orchestrates an Application delivery artifact
(HTTP/Worker runtime and its archived migrations) plus an optional Web release.
It does **not** yet accept FA's standalone migration packages, multi-Function
inventory, schedule convergence or business release manifest. Adding this
endpoint alone does not satisfy the FA one-command acceptance criteria.

Normal `deploy` rejects detected unsupported project release manifests and
backend declarations before any remote request instead of silently publishing
only Web. Detection covers `deploy-manifest.json`, one-level
`supacloud/*/deploy-manifest.json`, declared Edge Function targets, a compiler
configuration without an Application binding, and conventional Supabase backend
directories. This is a fail-closed guard, not a complete discovery engine for
arbitrary repository layouts. An explicit `--target` remains a component command,
not proof of a complete project release.

The missing platform implementation must consume the complete candidate, compare
it with verified target inventory, and select Web-only versus backend-plus-Web
internally. Customer scope creation/rebinding, Git diff classification and
manual inventory comparison are not an acceptable replacement. Destructive
migrations require an explicit reviewed decision; routine release planning does
not. See `fa-deployment-capability-boundary.md` for ownership and acceptance.

## Frontend Archive Cutover

Frontend uploads now use deterministic `tar.zst` only, with MIME
`application/vnd.supacloud.frontend.tar+zstd` and release metadata
`supacloud.frontend-release.v2` including `archive_format: "tar.zst"`.
The local CLI/Admin parameter is `archive_path`. ZIP, v1 release metadata,
`zip_path` and multipart source uploads are not accepted. Source uploads send the
raw archive body; immutable release uploads still require length and SHA-256.
Update CLI, Admin, Management API and Web Console together.

The CLI sorts tar paths and fixes timestamps, owners and permissions, then uses
asynchronous `Bun.zstdCompress` at level 3. Configuration and build contents use
`Bun.file`, and temporary archives use `Bun.write`. Untrusted uploads are decoded
as bounded zstd/tar streams, not as an unbounded `Bun.zstdDecompress` allocation.
Compressed bytes, window size, expanded bytes, file count and paths are bounded.
`Bun.zstdDecompress` and `Bun.zstdDecompressSync` remain available for trusted,
already-bounded local tooling; they are not used for the network upload reader
because the API does not expose an output limit or zstd window limit.
Archive tests exercise both native Bun decoders against the deterministic output,
including binary file bytes, and both Bun compressors against the bounded reader.
These small trusted fixtures do not bypass network upload validation.
Storage keeps bound descriptors, exclusive/no-follow creation, atomic publish
and durability checks; ordinary path-based writes cannot replace those gates.

Source-build static asset precompression also uses `Bun.file`, `Bun.write` and
asynchronous `Bun.zstdCompress` at level 3, without an external zstd executable.
Binary asset reads use `Bun.file(path).bytes()`. Optional image tools are resolved
with `Bun.which` once per optimization pass; missing tools leave originals intact.
HTTP gzip and Brotli sidecars remain separate from the tar.zst upload format.
This optimization does not rewrite retained immutable release trees.

This is a breaking format change, not an in-place inventory migration. Existing
v1 archives have different content hashes and cannot be renamed to tar.zst or
have their metadata edited in place. Old active authority, deployment pointers,
mutation journals, checkpoints and rollback receipts must remain intact.
Do not delete them to make the new server start accepting uploads.

The [offline cutover preparation tool](frontend-archive-cutover.md) verifies
frozen v1 inventory, prepares tar.zst candidates and records every digest mapping.
It does not switch routing, create a new live activation lineage, or rehearse
complete old-platform recovery. An existing environment with v1 authority or
retained v1 releases remains **blocked from direct production upgrade**.
A coordinated cutover must first:

1. Quiesce uploads and activations, reconcile unfinished mutations on the old
   platform, and record the current/previous activation identities.
2. Preserve the old binaries, archive inventory, trees, deployment pointers,
   authority, journal and receipts as one verified recovery snapshot.
3. Use the offline preparation tool to verify and repack retained trees and
   review the old-to-new digest mapping. A separately approved execution must
   create a new activation lineage and retain old receipts as historical
   evidence instead of rewriting them.
4. Prove the new active tree is byte-equivalent, route readback matches authority,
   and the previous release can be rolled back before reopening writes.
5. Rehearse restoring the old platform with its original authority and routing
   under quiescence. A binary-only downgrade cannot interpret v2 artifacts.

Fresh environments can use v2 immediately. Staging and production need independent
cutover evidence. Database backups retain their native `pg_dump`/physical formats;
this frontend change does not repackage database or Storage recovery data.

## Platform Responsibilities

SupaCloud owns archive validation and deduplication, atomic activation, current and
previous authority, CAS, durable receipts, unknown-outcome reconciliation and
retained rollback artifacts. The CLI owns local builds and concise progress.
Applications supply business migrations, permissions and authenticated acceptance
checks, not duplicate release inventories or ad hoc ZIP/SSH backup scripts.

Automatic recovery must be driven by confirmed platform state. A lost HTTP
response is not proof of failure and never authorizes a second activation.
Operator-requested rollback reuses a verified retained artifact and current CAS.
Automatic health-triggered downgrade additionally requires an explicit policy,
compatibility checks and verified rollback evidence; arbitrary database restores
or irreversible business-side effects are not safe automatic downgrade steps.
Those policies and live legacy cutover execution are not implemented by this change.

## Acceptance

```gherkin
Scenario: Review without publishing
  Given a read-only production profile and a prebuilt frontend
  When deploy --diff --skip_build is requested
  Then only remote GETs are sent
  And the plan binds project, deployment, tree and expected CAS

Scenario: Equivalent output needs no activation
  Given an active artifact with a different archive hash but the same verified tree
  When deploy is requested
  Then unchanged is true and no upload or activation is sent

Scenario: Preserve an uncertain write
  Given an activation response that cannot prove success
  When deploy returns
  Then mutation ID and original CAS remain in the failure receipt
  And the CLI never submits another activation

Scenario: The repository selects the Application path
  Given an application ID in supacloud.json and a selected test profile
  When deploy is requested without an application ID environment variable
  Then the CLI submits the Application candidate for the test environment
  And the platform resolves the current configuration and backend plan

Scenario: Never claim a partial release is a project release
  Given a Web target and detected backend declarations not supported by the orchestrator
  When default deploy is requested
  Then it reports PROJECT_DEPLOYMENT_UNSUPPORTED before remote requests
  And it does not suggest manually authoring a scope as the normal workflow

Scenario: A successful response must be bound
  Given HTTP 200 with ok true but a foreign or incomplete receipt
  When deploy receives the response
  Then it queries the same deployment ID without another POST
  And only a matching verified terminal receipt can confirm success

Scenario: Old archive input is rejected
  Given a ZIP archive or v1 frontend release metadata
  When the v2 platform receives it
  Then it rejects the request without changing active authority or routing

Scenario: Existing v1 authority is preserved
  Given a deployment retained by the old platform
  When the new platform cannot verify its v2 release record
  Then it fails closed
  And no authority, checkpoint, journal or old archive is removed or rewritten
```

Cold, warm, unchanged and rollback timings must be measured separately in
staging before production. Local tests prove behavior, not online latency or
competitive superiority.
