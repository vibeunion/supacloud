# Deployment Experience

The CLI owns the local build and one final result; Management owns immutable
artifacts, active authority, CAS, compatibility, mutation receipts and recovery.
Applications declare business schema, RLS, OAuth bindings and acceptance checks.

## Independent Release Paths

With a static frontend configured, `supacloud deploy` publishes only that frontend.
It does not compile the backend, run migrations, deploy Functions, converge
Storage or schedules, or wait for an Application deployment. `--assets_only`
remains an explicit frontend-only selection. A repository without a frontend
continues to use its configured Application path.

```bash
supacloud --env test deploy
supacloud --env test deploy --backend
supacloud --env test deploy --status <deployment-id>
```

The backend path builds and uploads the Application, pins an immutable
configuration, and inserts one durable `project_tasks` job before returning HTTP
202 and `status: accepted`. Configuration values remain in encrypted revisions,
not in public task payloads. The worker wakes through PostgreSQL notification,
with one-second fallback polling and bounded host concurrency. It executes the
existing migration/activation orchestrator independently of the HTTP request.
Local builds and uploads still take their actual time; 202 is not a latency claim.

Only a scope-bound, verified mutation receipt means `succeeded`. Queue success
alone cannot prove activation. A retry with the same identity must match the
original request and principal. Delivery after a lost acknowledgement reads a
completed receipt without re-executing. Transient failures before a mutation
starts may retry up to three attempts; interrupted side effects remain unknown
and require reconciliation. This does not implement arbitrary checkpoint resume.
Do not have CI treat `accepted` as release completion; read deployment status
until a verified terminal outcome before promoting dependent consumers.

These changes apply to Application artifacts and their archived migrations.
Standalone Function, database and Storage commands remain independent and are
not silently routed through this job type. A generic async migration/Storage
pipeline and a multi-Function submission protocol are not implemented here.
Static uploads still use whole archives; file-level incremental upload is
separate work. No fixed 30-second deadline is imposed.

### References

- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/):
  Worker deployment and D1 migration application are distinct commands.
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/):
  migration state is tracked independently of Worker code.
- [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/):
  preparing code and assigning traffic are separate operations.
- [Vercel deploy](https://vercel.com/docs/cli/deploy) and
  [promote](https://vercel.com/docs/cli/promote): `--no-wait` separates submission
  from waiting for readiness, while production assignment is a separate concern.

These are separation-of-responsibility references, not evidence that either
provider implements the same queue or guarantees a particular deployment time.

## Read-Only Comparison

```bash
supacloud --env staging app deploy-plan \
  --id orders --environment_id staging \
  --release_id <release-id> --configuration_id <configuration-id> --json
```

The removed `deploy --dry_run`, `--plan` and `--diff` flags are not supported.
Use Application planning for an existing backend candidate. A saved plan is
evidence, not a reusable write token. Publishing remains subject to read-only
mode and exact production confirmation; status reads require neither a build
nor production write confirmation.

Content-equivalent frontend trees skip upload and activation even if archive hashes
differ. Current integrity gates and exact post-activation readback remain.
Unknown activation results retain mutation ID, target release and original CAS;
inspect durable mutation status instead of retrying a write.

## One-Command Application Release

For the normal application path, the CLI provides one profile-backed release
workflow:

```bash
supacloud --env test deploy --backend
supacloud --env production deploy --backend --confirm-production production-ref
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
uses the project deployment resource for this Application path when selected
with `--backend` (or when no frontend is configured). Test and
production use the same command shape. The explicit advanced form remains available:

```bash
supacloud --env test app release \
  --id orders --environment_id test --configuration_path configuration.json
```

`app release` builds the local delivery manifest and uploads the immutable
release, then submits one durable project deployment job. SupaCloud owns the
deployment plan, backup, migration, runtime readiness and CAS activation behind
the mutation. The normal CLI does not include a Web binding. Use
`--configuration_id <uuid> --skip_build --manifest_path <path>` when reusing an
already reviewed configuration and manifest. `--format json` preserves the
acceptance status and deployment identity without claiming activation.
Activation evidence belongs to the later platform receipt; the standard
deployment output does not add phase timing or ask users to orchestrate those steps.

The workflow stops on the first failed or uncertain phase. A lost or malformed
deployment response triggers a bounded GET for the same deployment ID. A valid
202 returns immediately without polling. Only a
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

The project deployment endpoint currently queues an Application delivery artifact
(HTTP/Worker runtime and its archived migrations), independently of static Web.
The legacy Application orchestrator still supports an optional Web binding,
but the project endpoint rejects that binding.
It does **not** yet accept FA's standalone migration packages, multi-Function
inventory, schedule convergence or business release manifest. Adding this
endpoint alone does not satisfy the FA one-command acceptance criteria.

The backend Application path rejects detected unsupported project release manifests
and backend declarations before any remote request. Detection covers `deploy-manifest.json`, one-level
`supacloud/*/deploy-manifest.json`, declared Edge Function targets, a compiler
configuration without an Application binding, and conventional Supabase backend
directories. This is a fail-closed guard, not a complete discovery engine for
arbitrary repository layouts. The static path intentionally leaves these declarations
untouched and reports only a frontend receipt, never a complete project release.

Future standalone backend submission must compare its candidate with verified
target inventory without introducing work into the static path.
Customer scope creation/rebinding, Git diff classification and
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
retained rollback artifacts. The CLI owns the local build and concise final output.
Applications supply business migrations, permissions and authenticated acceptance
checks, not duplicate release inventories or ad hoc ZIP/SSH backup scripts.

## Server-Owned Release Preparation

Follow Wrangler's separation of immutable upload and deployment, rather than
exposing release orchestration to the customer. Cloudflare's
[asset upload protocol](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
returns the missing content from a manifest; its
[versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
separate preparing a version from assigning traffic. These are design references,
not evidence that SupaCloud already implements per-file asset uploads or complete
FA project deployment.

The first latency optimization batches project Function artifact verification
on the server with bounded concurrency. Runtime readiness is verified through a
server-only batch preheat endpoint: each worker pool rotates once, warms every
member, and returns per-member attestations before publication. The existing
project release authority remains the single Function publication point.
No CLI option, customer scope file or phase timing interface is added.

Application deployment planning now overlaps independent read-only evidence:
active authority with migration inspection, route verification with readiness,
and migration/journal read-back. When the verified plan proves that migrations
are already applied and no operator provisioning is required, deployment skips
the redundant migration execution-plan read. Migration writes, Function
activation, Web activation and final CAS/read-back remain ordered.

Management API requires the batch capability advertised by Edge Runtime; upgrade
the two services together. An older Runtime is rejected, not silently used through
the sequential preparation path. Worker LRU limits still apply, so readiness
attests successful loading, not simultaneous cache residency for all 128 members.
Both pools drain before the Runtime handler returns a preparation failure; a
network timeout does not prove the remote handler has finished.

Web uploads still send complete tar.zst archives. The next separate optimization
is a server-owned content manifest/upload session that requests missing files,
validates completion and binds the immutable result to deployment. Database state
is not a code-version rollback: migration and recovery policies remain separate.
There is no fixed timing promise; cold, warm and no-op paths need separate measurements.

```gherkin
Scenario: Prepare a complete Function release
  Given immutable versions belonging to one project
  When the server prepares the release
  Then local artifact checks have bounded concurrency
  And each member receives foreground and background readiness attestation
  And each runtime worker pool rotates only once for the complete release
  And only the complete verified result may reach publication

Scenario: Reject stale runtime readiness
  Given a prepared release
  When the runtime instance, either pool generation or tenant environment changes
  Then the server rejects readiness and does not publish a release

Scenario: Drain local preparation on failure
  Given multiple in-flight artifact checks or runtime worker pools
  When one preparation fails
  Then outstanding work finishes before its local preparation handler returns
  And no partial release is published

Scenario: Keep the deployment command simple
  Given a project configured for deployment
  When release preparation is optimized
  Then no extra CLI flags, timing configuration or client-side orchestration are required
```

Automatic recovery must be driven by confirmed platform state. A lost HTTP
response is not proof of failure and never authorizes a second activation.
Operator-requested rollback reuses a verified retained artifact and current CAS.
Automatic health-triggered downgrade additionally requires an explicit policy,
compatibility checks and verified rollback evidence; arbitrary database restores
or irreversible business-side effects are not safe automatic downgrade steps.
Those policies and live legacy cutover execution are not implemented by this change.

## Acceptance

```gherkin
Scenario: Read queued deployment without publishing
  Given a read-only production profile and an accepted backend deployment
  When deploy --status is requested
  Then only remote GETs are sent
  And pending is not reported as succeeded

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
  Given an application ID without a frontend in supacloud.json and a selected test profile
  When deploy is requested without an application ID environment variable
  Then the CLI submits the Application candidate for the test environment
  And the platform resolves the current configuration and backend plan

Scenario: Static publication does not invoke backend work
  Given a Web target and backend declarations
  When default deploy is requested
  Then only the frontend is built and published
  And Functions, migrations, Storage and schedules remain untouched

Scenario: Acknowledge only durable backend submissions
  Given a validated Application request
  When the queue insertion commits
  Then HTTP 202 reports accepted without executing the deployment in the handler
  And replaying the same request uses the existing task

Scenario: Restart after lost acknowledgement
  Given a completed mutation and a task whose acknowledgement was lost
  When a worker receives that task again
  Then it verifies the existing receipt without repeating migration or activation

Scenario: Unknown side effects are not automatically retried
  Given an interrupted mutation with effects that cannot be verified
  When a worker receives that task again
  Then reconciliation is required instead of re-executing the deployment

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
