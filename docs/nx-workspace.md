# Repository-only Nx tooling

## Contract and boundaries

Nx schedules repository engineering tasks; SupaCloud Compiler still owns application
semantics. Root development tooling pins Nx 23.2.1 with a Bun 1.4.2-generated lock.
Package-local locks, published manifests, generated applications and runtime APIs
are unchanged. `tsconfig.base.json` is an empty discovery path map, not an
application base config. The launcher resolves Nx through public `bin` metadata.

No remote cache, distributed execution, result caching, generator synchronization,
source migration, deployment or release automation is introduced by this rollout.
The existing full validation and packed/generated-consumer acceptance remain intact.

## Commands

```sh
# Root tooling and the existing Compiler parser are independent installs.
bun install --ignore-scripts --frozen-lockfile
bun install --ignore-scripts --frozen-lockfile --cwd packages/compiler
bun run check:workspace
bun run workspace:graph
bun run workspace:affected --base <known-good-commit>
bun run workspace:prepare --project supacloud-js
bun run workspace:build --project app
bun run test:workspace
bun run test:nx-acceptance
bun run check:source-boundaries
bun run check:source-regressions
```

Graph and affected commands return schema-versioned JSON with project identities,
edge kinds, local preparation targets, reasons and explicit completeness limits.
They do not rewrite source, project metadata or the baseline. Source checks use
the installed Compiler TypeScript parser, not an additional runtime dependency.

## Project dependencies are not task dependencies

Declarations and overrides in package manifests describe project relationships.
Registry-version edges inform conservative affected propagation; only `file:` and
`link:` edges add local preparation tasks. Overrides are not production declarations.
Malformed metadata, duplicate/reserved identities, symlinked package directories,
unresolved local packages and cycles fail rather than yielding an incomplete graph.

Nx owns ordering and deduplication. Existing scripts remain the task implementation:

```
B:repo-install -> B:repo-build -> A:repo-install -> A:repo-build
```

`repo-prepare` is an uncached Nx noop depending on A's local prerequisites. It does
not install or build A. Local dependencies with no build script still get
`repo-install`, including their transitive prerequisites. This prevents source-only
libraries from silently dropping a required upstream build.

The package-local install policy remains
`bun install --force --ignore-scripts --frozen-lockfile`. Native install hooks,
package-specific lifecycle steps, and scripts that independently rebuild other
packages require separate adapters and acceptance before migration. Outputs named
in uncached build targets are not a certification of cacheability.

The app/contracts build is a direct Nx pilot. The SDK Package Checks job now uses
Nx prerequisite preparation in place of its hand-maintained preparation list, then
runs its original install, type checks, build, consumer checks and tests. Other
legacy preparation chains remain unchanged; there is no fallback that hides an Nx
failure or runs both schedulers for the migrated SDK chain.

## Required CI and reviewed source debt

`nx-workspace.yml` is reusable, called by Management API CI, and included in its
stable `Required Checks` aggregate. It has no PR path filter, duplicated PR trigger,
write permission, or `continue-on-error` source gate. The aggregate rejects failure,
skipping or cancellation. Tests check the result binding and SDK migration wiring.

Two source commands serve different purposes:

- `check:source-boundaries` reports all current violations and exits nonzero on
  diagnostics. It does not call existing debt clean.
- `check:source-regressions` runs that same fresh scan and compares it with the
  reviewed `scripts/workspace/source-baseline.json`. Every new diagnostic or
  unverified-coverage note fails, including a new computed import. Known findings
  remain in the report with their reason; `gate.passed` does not imply `gate.clean`.

The initial budget records 33 diagnostics and 8 computed-import notes in the
923-file checkout inspected for this continuation. This is not 33 independent
architecture defects: one import can produce both private-entrypoint and
undeclared-dependency diagnostics. The legacy groups are admin compatibility/release
helpers, CLI build-time version metadata reads, a console delivery type bridge, and
the missing generated SvelteKit tsconfig in tooling-only checkouts. These need
separate packed-consumer or framework acceptance before changing their APIs.

Each allowance binds code, file, specifier, normalized-AST fingerprint and occurrence
count to a reason. Moving lines or adding comments does not consume a new allowance;
changing imports, symbols, destinations, files or adding duplicate occurrences does.
Configuration diagnostic fingerprints are checkout-independent and include the
TypeScript diagnostic code/message. Missing generated configuration may disappear
after framework synchronization; unused budgets are reported for manual removal.
There is intentionally no automatic baseline refresh command. Budget changes require
code review, including the reason and the actual fresh inventory.

## Source coverage and affected limits

The scanner covers handwritten JS/TS and declaration files under package `src`,
static imports/re-exports/import types, literal dynamic imports, require references,
imported `createRequire` aliases and `import.meta.resolve`. Resolved path aliases are
checked even when the written name looks like a public package or a self import.
Installed dependency copies are associated with their package, not mistaken for
source owned by the importer. New unresolved aliases and skipped source symlinks
are explicit unverified-coverage findings.

This is static workspace governance, not a complete JavaScript resolver or proof of
runtime isolation. Test files, fixture/generated directories and non-JS/TS templates
are excluded. Require binding detection is conservative, not full data-flow analysis.
Subpath policy requires explicit exports and is stricter than legacy Node deep imports.
Missing generated tsconfig parents remain diagnostics and do not stop scanning other
packages. Computed runtime loading remains unverified even when baselined.

Affected is still `mode: shadow`, `safeToSkip: false`. It includes both rename sides,
dirty/untracked inputs, deletion and missing/incorrect baseline fallback. Its graph
is manifest/local-resolution based, not the complete source or application-semantic
graph. Do not use it to prune CI. Passing a debt budget never authorizes CI pruning.

## Verification and rollback

Focused regressions cover metadata, CLI arguments, public bin resolution, source
forms/aliases/declarations, baseline counts/identity and failure handling. Real Nx
acceptance uses a diamond fixture plus a source-only dependency to verify ordering,
deduplication, prepare-only behavior, rebuilds after output deletion and failed
prerequisites preventing a consumer build. Real app/contracts and SDK acceptance are
additional evidence; fixtures do not replace them.

CI uploads only JSON inventories/graphs and tool-version evidence, not source,
node_modules or executable archives. No performance improvement is claimed without
measurements and no cached result replaces live external-service tests.

Rollback is a revert of the repository-tooling commits, restoring SDK's old
preparation invocation and the prior CI wiring. No deployed resource, application
migration, public runtime API or database schema needs rollback.
