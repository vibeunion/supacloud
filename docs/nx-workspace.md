# Repository-only Nx tooling

## Contract and boundaries

Nx schedules repository engineering tasks; SupaCloud Compiler still owns application
semantics. Root development tooling pins Nx 23.2.1 with a Bun 1.4.2-generated lock.
Package-local locks and runtime dependencies remain independent. Generated customer
applications do not require Nx. The launcher resolves Nx through public bin metadata;
`tsconfig.base.json` is a discovery path map, not a shared application configuration.

This rollout adds one owned starter-metadata synchronizer and enables local result
caching only for the reviewed contracts build. No remote cache, distributed execution,
CI pruning, customer-source migration, deployment or replacement release engine is
introduced. Full validation and packed/generated-consumer acceptance remain required.

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
bun run test:nx-acceptance
bun run test:nx-cache
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

Nx owns execution ordering and shared-task deduplication:

```
B:repo-install -> B:repo-build -> A:repo-install -> A:repo-build
```

`repo-prepare` only prepares A's local prerequisites; it does not install/build A.
Source-only local packages retain their installation task and transitive prerequisites.
The package-local installation policy stays
`bun install --force --ignore-scripts --frozen-lockfile`. Native hooks and scripts
that rebuild other packages require explicit adapters and consumer acceptance.

The app/contracts build and SDK prerequisite preparation are migrated paths. The SDK
keeps all its original install, type, build, consumer and test checks. Other legacy
preparation chains remain unchanged. No automatic fallback hides an Nx failure.

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

## Restricted local result cache

Only `@supacloud/contracts:repo-build` is eligible. Its package name, project name,
root and full sorted script fingerprint must match the reviewed policy. Any script
contract change disables caching until reviewed. Installs, tests, type checks,
external-service checks and all other package builds stay uncached.

The key covers project inputs, dependency inputs, shared scripts and build policies,
Node/Bun versions, operating system/architecture, effective environment and ignored
Bun/environment configuration. The context helper emits a digest, never configuration
or environment values. This conservative policy may miss reuse when unrelated
environment values change; it intentionally favors correctness over hit rate.
Cache contents are local to the workspace and must not be shared with untrusted
writers. No remote result store is configured.

`test:nx-cache` runs the actual contracts build in a fresh temporary workspace. It
checks a cold build, a hot hit after deleting outputs, exact output restoration,
stale-output removal, source/lock/shared-script/config/environment invalidation,
failure behavior and explicit cache bypass. It installs from the existing frozen
contracts lock; it is not a mock build. The regular full tests still execute live.

```sh
bun run nx run @supacloud/contracts:repo-build --skipNxCache
```

No measured speedup or universal cache validity is promised. Other targets require
separate output and input acceptance before joining the cache policy.

## Required CI and source debt

The reusable Nx workflow is part of Management API CI's stable Required Checks.
Failure, missing results, cancellation and skipping block that aggregate. It has no
second PR trigger, write permission or advisory source gate. Synchronization checks
and actual cache acceptance are now part of the same mandatory workflow.

`check:source-boundaries` returns all current diagnostics and fails on violations.
`check:source-regressions` performs the same fresh scan, then compares exact findings
against reviewed count-limited AST fingerprints. Every new diagnostic or unverified-
coverage note fails; known findings remain visible with reasons. A passing budget
is not a clean architecture report. No automatic baseline refresh is provided.

This continuation removes 17 starter-metadata allowances by removing their offending
imports, not by relaxing the scanner. Remaining admin compatibility/release helpers,
console type bridges, generated framework configuration and runtime-selected loaders
still require targeted review. The initial 33 diagnostics and 8 notes were not 33
independent architecture defects: one import can produce multiple diagnostics.
Unused allowances are reported and should be removed rather than reused as a budget.

## Coverage, acceptance and rollback

Static coverage includes handwritten JS/TS/declarations under package src, re-exports,
import types, literal dynamic imports, imported createRequire aliases and resolvable
path aliases. New unresolved aliases and skipped source symlinks are explicit coverage
findings. Test files, fixture/generated directories and non-JS/TS templates are outside
this scan. It is not whole-program resolution or proof of runtime isolation.

Affected remains `mode: shadow`, `safeToSkip: false`. It handles dirty/untracked inputs,
rename sides, deletion and invalid baselines; generation edges add starter coverage,
not complete application semantics. Neither a passing debt budget nor a cache hit
authorizes pruning CI. Unknown inputs still require conservative full validation.

CI keeps small graph, scan, affected, cache-acceptance and tool-version evidence;
source snapshots, node_modules and executable archives are not uploaded. Existing
consumer, ESM and full repository acceptance remain separate required evidence.

Rollback these tooling changes to restore uncached contracts builds and the original
CLI manifest reads, along with their prior explicitly reviewed source allowances.
No database schema, deployed resource or customer application requires rollback.
