# Application generation and candidate-package acceptance

SupaCloud keeps one application generator, compiler and runtime model. This
iteration takes inspiration from AponiaJS's complete resource generation,
preflighted changes and packed-consumer testing. It does not import AponiaJS,
replace dependency injection, or change the Elysia **2.0.0-beta.19** baseline.

## Generate a complete read resource

Preview before applying:

```sh
supacloud-cli app generate --kind resource --name inventory --dry-run --format json
supacloud-cli app generate --kind resource --name inventory
```

`supacloud-cli generate` is an alias of the same implementation. Both hyphenated
`--dry-run` / `--register-in` and tool-style `--dry_run` / `--register_in` are
accepted. Supplying both aliases of one flag is an error. `--dry-run` applies to
`generate`, not to `init`, deployment, or compilation; using it there is rejected
rather than silently performing a write.

The default directory is `src/features`, overridden by a project-relative `--dir`.
Paths and `--register-in` use forward slashes on every operating system.

```text
src/features/inventory/
  inventory.model.ts
  inventory.service.ts
  inventory.controller.ts
  inventory.module.ts
  inventory.service.test.ts
  inventory.controller.test.ts
```

The model declares the parameter and response schemas once. The result type is
derived from the response schema. The Service imports that type only; the HTTP
contract lives in the model/controller boundary. The Module registers the Service
and Controller using existing SupaCloud metadata. No new runtime dependencies,
reflection container, ORM or duplicated validator is introduced.

The generated `GET /inventory/:id` validates a 1–128-character alphanumeric,
underscore or hyphen identifier. The Service deliberately throws until a real,
authorized project read port is supplied. There is no in-memory production store,
fake persistence success, inferred permission, or generated write command. Replace
the placeholder and its test when implementing the feature. Mutations belong in
the existing governed Command boundary, not in a generated HTTP after-hook.

## Explicit parent-module registration

A generated Resource is internally wired, but the generator does **not** guess a
root module, instantiate services, or search for an arbitrary decorator to edit.
When a parent import is needed, name its file:

```sh
supacloud-cli app generate --kind resource --name inventory \
  --register-in src/app.module.ts --dry-run --format json

supacloud-cli app generate --kind resource --name inventory \
  --register-in src/app.module.ts
```

Choose an application composition module, not an unrelated feature module: the
existing boundary rules may forbid feature-to-feature imports. The packed test
adds an explicit `type:app` composition fixture without weakening those rules.
The same registration flag works with `--kind module`.

Registration reuses the compiler's `add_module_import` AST editor in preview mode.
Ambiguous module declarations, dynamic imports arrays, missing files, conflicting
symbols and filesystem conflicts reject the operation before generation writes
anything. Preview includes the parent edit alongside the six new files. Existing
single-file generators retain their previous registration semantics: this release
does not silently insert individual commands, controllers, queries or jobs into a
module or invent their required governance metadata.

## File-safety contract

All targets are checked before a directory or output file is created. Targets
must be project-relative regular paths. Absolute/outside paths, symlink targets
(including dangling links), symlink ancestors, hard-linked target files, reserved
paths and overlapping/case-colliding plan entries are rejected. Resource generation
never accepts `--force`; existing single-file force behavior remains available for
regular files, while a Controller still requires manual merging.

`--dry-run` performs this same planning and returns exact candidate contents
without writing files, creating directories or acquiring a write lock. Normal
execution rechecks the planned source snapshots before applying. Generator
processes coordinate using an exclusive `.supacloud-generate.lock`. New files are
published exclusively and registration edits are applied after new declarations.
Handled write errors trigger rollback of still-owned outputs; independently
changed files are preserved and incomplete recovery is reported.

This is **not** a crash-atomic multi-file filesystem transaction and is not a
sandbox against a hostile local process changing paths between filesystem calls.
Do not edit generated targets concurrently. After a killed generator, inspect the
working tree and any reported temporary files before removing a stale lock;
never remove the lock of a running generator.

JSON generation answers are versioned and contain `ok`, `written` and `changes`.
An unsuccessful JSON generation returns `ok: false`, a stable scaffold error code
when available, and a failing CLI exit status. AST-editor errors use
`SCAFFOLD_FAILED`; no error is converted into a successful preview.

## One diagnostic source

```sh
supacloud-cli app compile --format json
supacloud-cli app check --format json
supacloud-cli app context --target InventoryService --format json
supacloud-cli app graph --out_dir candidate-generated --format json
```

Compile JSON reports compiler diagnostics and written paths. Check JSON reports
diagnostics, generated-artifact mismatches, module names, `upToDate` and an empty
`written` array; its exit status remains failing when diagnostics or mismatches
block acceptance. These are projections of the existing compiler, not another
validation engine. Configuration loading still follows the existing compiler's
trusted-project behavior; a source check is not a sandbox for untrusted config.

Graph and explain read **generated artifacts**, honoring the configured output
directory or explicit `--out_dir`. They do not claim to show the live mounted
Elysia route table. Context/check inspect current declarations. The Devtools wire
protocol is unchanged. Runtime UI and route-drift visualization are outside this
iteration.

`export-tools --format json` remains read-only and no longer creates an output
directory. Its `--out_dir` selects exported-file output, not the manifest source;
the source manifest comes from the project's configured generated directory.

## Verify what users install

```sh
bun run scripts/check_app_generation.ts
```

The acceptance script builds and packs candidate packages, installs the **packed
CLI** outside the workspace, and runs `app init` and `app generate` through that
CLI. Project-owned dependencies are overridden to candidate tarballs; third-party
version declarations remain intact. Consumer installation is followed by a frozen,
offline pass. The test does not publish packages or contact a Management API.

It verifies preview/apply equality, parent registration, conflict refusal, CLI
aliases, structured compile/check/context, non-default graph output, generated
unit tests, type checking and bundling. A separate test-owned Service instance
is used to exercise successful compiled HTTP routing; the untouched generated
placeholder must first return a redacted server error. Invalid input must stop
before that Service executes. A loopback listener also exercises the native
Elysia 2 registration path. No production persistence or deployment is claimed.

The `App Generation Acceptance` workflow runs this path on pinned Bun 1.4.2 and
then runs generator safety plus existing app-tool regressions. Existing Elysia
compatibility and wider package checks remain separate and unchanged.

## Reference

Design reference only; no AponiaJS source was copied:

- AponiaJS CLI guide at commit `b251254053dc37a632446642a1a13c83c4ee2dee`:
  https://github.com/aponiajs/aponiajs/blob/b251254053dc37a632446642a1a13c83c4ee2dee/docs/cli.md
- Packed generated-application acceptance at the same commit:
  https://github.com/aponiajs/aponiajs/blob/b251254053dc37a632446642a1a13c83c4ee2dee/packages/cli/e2e/generated-application.e2e.ts

SupaCloud-specific implementation follows this repository's contribution terms.

Registration also refuses a parent that already references the new module symbol.
This conservative collision check can include comments; review and register that
case manually rather than silently aliasing or replacing an existing binding.
