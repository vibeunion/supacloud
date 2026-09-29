# Application generation and candidate-package acceptance

SupaCloud keeps one application generator, compiler and runtime model. AponiaJS's
complete resource generation, preflighted changes and packed-consumer testing
informed this workflow. No AponiaJS code or runtime is imported. Elysia stays at
**2.0.0-beta.19**; the existing DI, governance and Devtools contracts remain in use.

## Create an application and add a feature

With the matching candidate/released CLI installed:

```sh
supacloud-cli app init --template http --name catalog-api --root ./catalog-api
cd catalog-api
bun install
supacloud-cli app generate --kind resource --name inventory \
  --register-in src/app.module.ts --dry-run --format json
supacloud-cli app generate --kind resource --name inventory \
  --register-in src/app.module.ts
bun run check
bun run inspect
```

New **HTTP and edge** starters ship `src/app.module.ts`, a `type:app` composition
module importing the actual `OrdersFeature` or `SyncFeature` supplied by that
starter. The compiler discovers it. New resources belong in that root, not in an
unrelated feature. No module-boundary policy is relaxed to make registration work.
Existing projects and the full `command` starter are not automatically migrated;
choose or create their explicit composition module before using `--register-in`.

`supacloud-cli generate` is the same generator's top-level alias. Hyphenated
`--dry-run` / `--register-in` and tool-style `--dry_run` / `--register_in` are
accepted. Supplying both aliases of a flag is an error. `--dry-run` is supported
for generation, not init, compilation or deployment; misuse is rejected.

## What a resource contains

The default directory is `src/features`, overridden by a project-relative `--dir`.
Paths use forward slashes on every operating system.

```text
src/features/inventory/
  inventory.model.ts
  inventory.service.ts
  inventory.controller.ts
  inventory.module.ts
  inventory.service.test.ts
  inventory.controller.test.ts
```

The model declares parameter/response schemas once. `RouteHandlerOutput` derives
the result type from the response schema. The Service imports that type only and
exposes an asynchronous `find` method; the Controller delegates its Promise. This
supports database/network reads without changing both signatures later. The
Module registers the Service and Controller through existing SupaCloud metadata.

`GET /inventory/:id` validates a 1–128-character alphanumeric, underscore or hyphen
identifier. The Service **rejects until an authorized, project-bound read port is
implemented**. There is no in-memory production store, fake persistence, inferred
permission, new ORM or duplicate validator. Replace the placeholder and its test
together. The controller tests cover asynchronous success and original-error
propagation. Mutations belong in a governed Command, not an HTTP after-hook.

## Parent registration is explicit

Omit `--register-in` to generate only the internally wired feature. Supply it to
add the new Module to an existing composition module using the compiler's
`add_module_import` AST editor. The same flag supports `--kind module`.

Registration never guesses a root or instantiates application services. Ambiguous
module declarations, dynamic import arrays, missing parents, conflicting symbols
and filesystem conflicts reject the operation before generation writes anything.
Preview contains the parent edit and all six new files. The conservative symbol
collision check also sees comments; register such cases manually after review.

Individual command, query, controller and job generators retain their existing
registration semantics; this change does not silently insert them into modules
or invent their governance metadata. Newly generated modules must obey the
project's architecture and compile before use.

## File-safety contract

The whole write set is checked before creating directories or output. Targets
must be project-relative regular paths. Absolute/outside paths, symlink targets
(including dangling links), symlink ancestors, hard-linked target files, reserved
paths and overlapping/case-colliding plan entries are rejected. Resources never
accept `--force`. Supported single-file force behavior remains; a Controller
still requires manual merging.

Preview writes no files, directories or lock. Application rechecks source
snapshots, coordinates generator writers with `.supacloud-generate.lock`, publishes
new files exclusively and edits registration after the new declarations. Handled
write errors roll back still-owned output; independent edits are preserved and
incomplete recovery is reported.

This is **not** a crash-atomic multi-file transaction or a sandbox against hostile
local writers. Do not edit target files concurrently. After a killed process,
inspect the working tree and reported temporary files before recovering a stale
lock. Never remove a running generator's lock.

Generation JSON is versioned and contains `ok`, `written` and `changes`. Failed
JSON generation returns `ok: false`, a stable scaffold code when available and a
failing CLI exit status. AST-editor errors use `SCAFFOLD_FAILED`, not a successful
preview. Accepted input can still be rejected by the project's compiler policy.

## One diagnostic source, two kinds of evidence

```sh
bun run inspect
supacloud-cli app compile --format json
supacloud-cli app check --format json
supacloud-cli app context --target InventoryService --format json
supacloud-cli app graph --out_dir candidate-generated --format json
```

The HTTP/edge starter's `inspect` script calls the installed compiler's
`graph --json`. It describes **current source declarations** without starting the
application, constructing services or regenerating artifacts. Configuration is
still trusted executable project code; inspection is not an untrusted-code sandbox.

The project CLI's `app graph` and `app explain` instead read **generated artifacts**,
honoring configured output or `--out_dir`. They do not describe live mounted routes.
After source changes, compile before trusting artifact-backed inspection. No new
Devtools protocol, live endpoint or route-drift UI is introduced here.

Compile JSON reports diagnostics and written paths. Check JSON reports diagnostics,
artifact mismatches, module names, `upToDate` and an empty `written` array. A
failed check remains nonzero and never repairs drift. In CI, run
`bun run check:generated` before any regenerating command; `bun run check` is the
convenient first-use bootstrap, not a substitute for drift detection.

`export-tools --format json` is read-only and does not create output directories.
Its `--out_dir` selects export output, not the manifest source; that source comes
from the configured generated directory.

## Verify the packages users install

```sh
bun run scripts/check_app_generation.ts
```

The acceptance builds/packs candidate packages, installs the **packed CLI outside
the workspace**, and invokes init/generate through that CLI. Only project-owned
dependencies are redirected to candidate tarballs. The generated Elysia declaration
is checked and retained. Consumer installation is repeated frozen and offline.

Coverage includes the HTTP starter's unmodified composition root, preview/apply
equality, registration, conflicts, aliases, structured compile/check/context,
Schema-derived types, async resource tests, and application build. A test-owned
Service instance supplies the successful read; the untouched placeholder and an
asynchronous adapter failure must both return redacted errors. Invalid input must
not enter the Service.

A separate loopback test loads `dist/application.js` and serves both original and
new routes from the **complete built application**, without replacing a business
file or hand-mounting a feature. Inspection must not rewrite generated code;
intentional artifact drift must fail JSON check without repair. Non-default output
is exercised, and a second packed edge starter is checked, built and inspected
using its own generated composition root. No job is scheduled by this acceptance.

`App Generation Acceptance` runs on pinned Bun 1.4.2 with contents-read-only
permissions. It also runs CLI typecheck, original generator regressions, filesystem
safety and new composition tests. Dependency changes in commands/db/delivery also
trigger it. Elysia policy runs even when another step fails (unless cancelled).
Wider CI remains separate. No production persistence, deployment or live identity
acceptance is claimed by this lane.

## Reference

Design reference only, at AponiaJS commit `b251254053dc37a632446642a1a13c83c4ee2dee`:

- https://github.com/aponiajs/aponiajs/blob/b251254053dc37a632446642a1a13c83c4ee2dee/docs/cli.md
- https://github.com/aponiajs/aponiajs/blob/b251254053dc37a632446642a1a13c83c4ee2dee/packages/cli/e2e/generated-application.e2e.ts

Implementation follows SupaCloud's contribution terms; no AponiaJS source copied.
