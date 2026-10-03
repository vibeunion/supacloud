# Repository-only Nx tooling

## Task contract

Goal: make the existing Nx project metadata executable without changing SupaCloud
runtime dependencies, generated applications, package-local Bun locks, release
automation, or the existing required consumer acceptance.

This rollout adds a repository-local Nx adapter, graph diagnostics, shadow affected
reports, and an opt-in source boundary checker. Nx owns task scheduling and
shared-task deduplication. The Compiler continues to own application-semantic
analysis. This is not a second task scheduler or a runtime framework migration.

Required review areas: Bun/Node ESM compatibility, workspace architecture policy,
CI permissions, real-consumer acceptance, and failure/rollback behavior.

## Commands

Install repository development tooling with `bun install --ignore-scripts --frozen-lockfile` (root only). Package
installation remains independent; no package-manager workspaces are introduced.
The root pins Nx 23.2.1, verified with the repository's Bun 1.4.2 lockfile v2.
`tsconfig.base.json` only supplies an empty path map for local Nx plugin discovery;
no application configuration extends it. The launcher resolves Nx's public `bin`
metadata instead of depending on an internal directory layout.

```sh
bun run check:workspace
bun run workspace:graph
bun run workspace:affected --base <known-good-commit>
bun run workspace:build --project app
bun run test:workspace
bun run test:nx-acceptance
bun run check:source-boundaries
```

The source checker uses the parser from `packages/compiler`; install that package's
locked development dependencies first. `workspace:graph` and `workspace:affected`
return versioned JSON with edge kinds, paths, selection reasons and explicit
completeness limits. They do not write project metadata or application source.

## Graph and execution semantics

`package.json` declarations plus existing `project.json` identities are the source
of truth. Registry-version relationships inform conservative affected propagation;
only `file:` / `link:` relationships currently introduce local build prerequisites.
Overrides are resolution inputs, not production declarations. Unresolved local
links, duplicate identities, cycles and unsupported nested overrides fail closed.

Inferred tasks use a `repo-` prefix to avoid replacing existing script targets.
For a local dependency B of A, the order is:

```
B:repo-install -> B:repo-build -> A:repo-install -> A:repo-build
```

The initial install adapter matches the existing dependency preparation policy:
`bun install --force --ignore-scripts --frozen-lockfile`. Packages requiring native
install scripts or extra lifecycle steps must receive explicit adapters and real
consumer tests before their CI is switched. App/contracts is the initial pilot.
All task-result caching is disabled, including tests and installs. Nx Cloud is not
configured. Pure-build caching needs output-restoration and input-invalidation
acceptance before opt-in; external-service checks are not cache candidates.

Packed/generated-consumer acceptance is a distinct tooling project conservatively
depending on every repository package. It delegates to the existing
`scripts/check_app_generation.ts`, not a replacement generator or runtime package.
The existing Required Checks workflow remains unchanged and still runs its original
full validation. The new workflow cannot make an existing failure disappear.

## Shadow affected and source boundary rollout

Affected reports are advisory: `mode: shadow`, `safeToSkip: false`. They include
staged/unstaged changes, untracked inputs and both sides of renames. Unknown baselines,
head/checkout mismatches, shared files and removed/unowned projects require full
validation. The graph does not yet include every source alias, template relation or
application-semantic edge. Do not use it to prune CI.

The AST source checker reuses `WORKSPACE_BOUNDARY_RULES` from the existing checker.
It covers static JS/TS imports, exports, import types, literal dynamic imports,
`require`, deep package imports and resolvable TypeScript path aliases under package
`src`. Test files (including `*.test-fixtures.*`), fixture/generated directories
and non-JS/TS templates are excluded. Subpath governance requires an explicit public
`exports` entry; this is deliberately stricter than Node's legacy deep-import
resolution for packages without `exports`, not a complete Node resolution emulator.
Missing generated tsconfig parents produce `WS_TSCONFIG` diagnostics without
preventing other packages from being scanned.
Computed imports are reported as unverified. A zero-diagnostic report is not proof
of runtime isolation. The command fails on violations; the new CI inventory is
advisory until existing findings are reviewed. Regression tests remain mandatory.

No synchronization/migration writes are introduced. A future sync operation must
have a preview, conflict handling, idempotence tests and preservation of user edits.

## Acceptance and rollout

Unit regressions cover declaration edges, local resolution, task configuration,
reverse closure, missing baselines, rename/delete handling, metadata errors, source
AST forms and public export rules. Real Nx acceptance must run with the pinned
installed Nx and Bun; it verifies diamond ordering, shared-task deduplication,
uncached rebuilds after deleting outputs, and dependency failure propagation.
Neither fixtures nor source checks replace actual generated-consumer acceptance.

The Nx workflow verifies all focused regressions, the actual repository project
graph, real task execution on a diamond fixture, and the app/contracts build pilot.
It preserves only graph, affected, source-inventory and tool-version evidence;
source snapshots, node_modules and executable archives are not uploaded.

Source inventory is still advisory. In the reviewed checkout it reports existing
cross-package/private-entrypoint imports and a missing generated SvelteKit tsconfig;
these are not silently suppressed or represented as a clean architecture audit.
Computed imports remain explicitly unverified. Remediating those findings or
promoting the inventory to a mandatory gate requires a separate review.

The legacy dependency-build helper remains available; this pilot does not yet
replace every package's preparation steps. Affected pruning, generator sync writes,
cache enabling, distributed execution and runtime changes are outside this slice.
Do not claim full CI, native-package, cache or performance validation without the
corresponding evidence.

Rollback: revert the repository tooling commit. No production API, runtime package
manifest, deployed resource, schema migration or generated application is changed.
