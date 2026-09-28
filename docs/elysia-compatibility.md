# Elysia dependency boundary and beta upgrade policy

## Scope

SupaCloud's application metadata and compiler packages do not declare Elysia as
an npm dependency. This is a package boundary, not a claim that the whole
application installation, schema language or compiler migration policy is
framework-independent.

- Business modules, services and commands should depend on SupaCloud contracts
  and explicitly supplied request/job inputs, not native Elysia Context types.
- A server using `@supacloud/elysia` still installs Elysia to satisfy the adapter's
  peer dependency, even when business source files never import it. Its bootstrap
  may use `createApplication`, native Elysia plugins and native routes.
- Compiler migration acceptance intentionally checks a complete host tuple,
  including Elysia. That tooling check is not a runtime dependency on Elysia.
- Shared schemas still use `typebox`. Keeping Elysia out of package manifests
  does not remove TypeBox compatibility work or prove support for another adapter.
- Native `http` plugins remain an explicit escape hatch. Keep native context,
  lifecycle and plugin types in the host layer instead of copying them into the
  domain contract. Translate verified identity and request data at that boundary.

## Benefits and costs

The boundary limits the parts of business code exposed to HTTP-framework API
changes, lets HTTP and worker/CLI ingress reuse domain operations, and allows
business tests to run without starting an HTTP server. These benefits require
business code to respect the boundary; deleting an npm dependency alone is not
enough.

The adapter must translate validation, error/status handling, cookies, lifecycle
hooks and request-scope teardown correctly. That is additional implementation
and regression-test cost. A neutral compiled descriptor cannot automatically
provide all of Elysia's native route inference, macros or plugin behavior. Use
native host composition for those features rather than expanding every
framework-specific option into the core application model. No performance
improvement, zero overhead or framework portability is established by this PR.

## Beta policy

`packages/elysia/compatibility.json` records the required acceptance target, not
proof that a test run passed. The Elysia target is `2.0.0-beta.19`, with active
`typebox` 1.3.34 and `exact-mirror` 1.2.6. Bun and both TypeScript engines are
also recorded. The adapter peer and development dependencies, repository-owned
direct Elysia consumers, CLI scaffold literals and compiler migration target must
agree. Published templates retain version literals so that the compiler and CLI
do not acquire a runtime dependency on the adapter just to read its metadata.

An exact beta peer prevents silently claiming support for untested versions, but
it also requires coordinated adapter releases and consumer upgrades. A security
fix in a newer beta still needs prompt review, testing and a deliberate update;
an exact pin is not a reason to postpone security maintenance.

`node scripts/check-elysia-compatibility.mjs` checks those declarations, the
adapter's resolved lockfile tuple, each direct consumer's locked Elysia version
and local `file:../elysia` peer snapshots. Its regression tests run with
`node --test scripts/check-elysia-compatibility.test.mjs` and do not need Bun or
installed dependencies. This is a declaration/lock-metadata gate, not a scan of
all source imports and not a substitute for `bun install --frozen-lockfile`.

The Elysia Compatibility workflow separately builds local dependencies, installs
with the frozen lockfile, checks types, and runs native/adapter HTTP conformance
and generated-contract upgrade acceptance. Database isolation and durable
command tests remain separate acceptance requirements. A queued or skipped gate
is not success. Historical benchmark/acceptance reports keep their actual old
runtime versions; they must not be relabeled as Elysia 2 results.

The policy deliberately does not force-rewrite third-party published package
metadata or isolated user Function dependencies. Consequently it does not claim
that every transitive dependency in every repository lockfile is Elysia 2.
Functions using an isolated Fetch/handle boundary need their own compatibility
checks; pinning the scaffold default does not migrate already-deployed functions.

## Upgrade and rollback

Change the target tuple, owned manifests, both direct and copied adapter lock
metadata, templates and migration policy together. Regenerate affected locks
using the recorded Bun version and review the diff. Run the declaration tests,
frozen installs, native conformance, generated-contract/type checks, scaffold
checks and the separate runtime-safety gate before marking the upgrade accepted.
Do not widen the beta peer from a single-version test result.

Rollback means restoring the prior coordinated manifests, locks and generated
artifacts, rebuilding and redeploying the application. It does not undo completed
business operations or durable side effects.
