# Repository workspace tooling

## Contract and boundaries

Bun runs package scripts. A small repository runner orders those scripts across
local `file:` and `link:` dependencies. SupaCloud Compiler still owns application
semantics. Package-local locks and runtime dependencies remain independent.
Generated customer applications do not use this runner. `tsconfig.base.json` is a
discovery path map, not a shared application configuration.

This tooling does not add a remote cache, distributed execution, CI pruning,
customer-source migration, deployment, or a replacement release engine. Full
validation and packed/generated-consumer acceptance remain required.

`bun --filter` is not the scheduler. It selects packages inside one Bun workspace
and runs one script name in dependency order. This repository is not a Bun
workspace: each package has its own lockfile, and turning the root into a
workspace would change `bun install`. Verification-only edges, source-only
installs, and prepare-without-building-the-consumer are also outside package
dependency order. The runner walks those edges explicitly and then invokes Bun.

## Commands

```sh
bun install --ignore-scripts --frozen-lockfile
bun install --ignore-scripts --frozen-lockfile --cwd packages/compiler
bun run check:workspace
bun run workspace:graph
bun run workspace:affected --base <known-good-commit>
bun run workspace:prepare --project supacloud-js
bun run workspace:build --project app
bun run workspace:sync
bun run check:workspace-sync
bun run test:workspace
bun run test:workspace-acceptance
bun run check:source-boundaries
bun run check:source-regressions
```

Graph and affected commands return versioned JSON with identities, edge kinds,
preparation targets, selection reasons and completeness limits. The source scanner
reuses the Compiler's installed TypeScript parser. Neither command rewrites the
source-debt baseline or silently fixes user code.

## Project, generation and task dependencies

Manifests plus existing project metadata are authoritative. Registry-version edges
inform affected analysis; only file/link dependencies introduce local preparation
tasks. Overrides describe resolution, not a production dependency declaration.
The CLI additionally depends on its starter metadata producers through `generation`
edges (source CLI, target producer). A producer change affects CLI validation without
adding a runtime dependency.
Missing producers fail discovery. These edges do not install or build the producers.

The runner owns execution ordering and shared-task deduplication. It runs one
package command at a time and stops on the first failure. Graph preparation
targets still include `params: ignore`; the runner does not forward arguments
to dependencies:

```
B:repo-install -> B:repo-build -> A:repo-install -> A:repo-build
```

`repo-prepare` only prepares A's local prerequisites; it does not install/build A.
Source-only local packages retain their installation task and transitive prerequisites.
The package-local installation policy stays
`bun install --force --ignore-scripts --frozen-lockfile`. Native hooks and scripts
that rebuild other packages require explicit adapters and consumer acceptance.

The app/contracts build and SDK prerequisite preparation use this runner. The SDK
keeps all its original install, type, build, consumer and test checks. Other legacy
preparation chains remain unchanged. A failed Bun command is not hidden or retried.

Compiler `build` and `typecheck` stay exclusive because their lifecycle hooks
rewrite shared contracts and DB outputs. Sequential execution is stricter than the
old scheduler, which could run unrelated packages beside each other: independent
branches no longer overlap. That keeps Windows package installs from racing the
shared extraction cache as well.

There is no local result cache. `@supacloud/contracts` builds run live on every
request. The previous single-target cache, its dotenv preflight, and
`test:nx-cache` are gone. An environment-specific build is `bun run build` in the
package directory.

## Starter synchronization and release consistency

CLI starter source imports the local `starter-metadata.json`, not sibling package
manifests. Only the version and dependency fields actually embedded in the starters
are copied. Embedded constraints must be exact, caret or tilde semver versions; URL,
file/link/workspace and arbitrary tagged sources are rejected rather than copied.
No credentials or runtime configuration are part of this metadata.

`workspace:sync` previews the complete before/after objects and a `planHash`, without
writing. After reviewing that preview, apply the exact token:

```sh
bun run workspace:sync --apply --expect <planHash>
bun run check:workspace-sync
```

The token binds both the current destination and fresh producer values. Applying a
stale token fails. Writes use an exclusive cooperative lock, a temporary file and
atomic replacement of this single generator-owned file. Repetition does not rewrite
unchanged bytes. Symlinks, multiply linked files, unowned content, custom fields at
any depth and unexpected field types are rejected; there is no force-overwrite mode.
This is not a general filesystem transaction or protection against a hostile process
with permission to race arbitrary filesystem operations.

The mandatory check is read-only and fails on drift. Per-producer release-please
JSON extra-file updates keep embedded package versions aligned with release PRs.
The checker validates those mappings too. Changes to external dependency policies
(e.g. RxJS or Drizzle constraints) require a reviewed sync; version updates alone
do not silently rewrite them. Existing release tooling, permissions and publication
conditions remain in place. This does not force a new CLI release for every producer
release; the CLI embeds the tuple in its next normal build/release.

The generated file and updated CLI imports are covered by real packed/generated-
consumer acceptance. This synchronizer does not modify customer projects, regenerate
business code, migrate databases or claim to synchronize every SupaCloud artifact.

## Required CI and source debt

The reusable workspace workflow is part of Management API CI's stable Required Checks
aggregate. Failure, missing results, cancellation and skipping block that aggregate.
It has no second PR trigger, write permission or advisory source gate. The aggregate
check name stays `Required Checks`. The member job is `workspace-tooling`.

`check:source-boundaries` returns all current diagnostics and fails on violations.
`check:source-regressions` performs the same fresh scan, then compares exact findings
against reviewed count-limited AST fingerprints. Every new diagnostic or unverified-
coverage note fails; known findings remain visible with reasons. A passing budget
is not a clean architecture report. No automatic baseline refresh is provided.

Removing starter-metadata allowances means removing their offending imports, not
relaxing the scanner. Remaining admin compatibility/release helpers, console type
bridges, generated framework configuration and runtime-selected loaders still
require targeted review. Unused allowances are reported and should be removed
rather than reused as a budget.

## Coverage, acceptance and rollback

Static coverage includes handwritten JS/TS/declarations under package src, re-exports,
import types, literal dynamic imports, imported createRequire aliases and resolvable
path aliases. New unresolved aliases and skipped source symlinks are explicit coverage
findings. Test files, fixture/generated directories and non-JS/TS templates are outside
this scan. It is not whole-program resolution or proof of runtime isolation.

Affected remains `mode: shadow`, `safeToSkip: false`. It handles dirty/untracked inputs,
rename sides, deletion and invalid baselines; generation edges add starter coverage,
not complete application semantics. Neither a passing debt budget nor a successful
package build authorizes pruning CI. Unknown inputs still require conservative full
validation.

CI keeps small graph, scan, affected and tool-version evidence; source snapshots,
node_modules and executable archives are not uploaded. Existing consumer, ESM and
full repository acceptance remain separate required evidence. Packed consumer
acceptance stays the app-generation workflow.

Rollback of this runner restores direct package installs and builds. No database
schema, deployed resource or customer application requires rollback. Merging this
tooling does not deploy or publish packages.
