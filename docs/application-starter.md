# Application Starter

## Goal and Boundaries

The developer's job is to create a typed, governed service and verify its behavior
without assembling framework packages, compiler settings or test adapters by hand.
`supacloud app init` supplies that local development loop, using the existing
`@supacloud/app`, `@supacloud/compiler` and `@supacloud/elysia` ownership boundaries.
There is no aggregate `framework` package.

This is not an automatic deployment, production identity provider, database
emulator, general-purpose workflow engine or complete Maker-Checker application.
Business persistence and authorization remain application-owned.

## Start

After the CLI release containing this command is published:

```sh
supacloud app init --root ./orders --name orders
cd orders
bun install
bun run check
bun run dev
```

The published CLI also exposes the same local loop through an application-level
entry, without reaching for a remote test server:

```sh
supacloud-cli app dev --profile fast          # local/ephemeral, safe defaults
supacloud-cli app dev --profile integration   # requires an explicit database URL
```

The project CLI binary also supports `supacloud-cli app init`. Initialization is
local, needs no account or API token, never installs dependencies automatically,
and refuses non-empty or symlink targets. A `.git` directory is allowed. `--force`
does not bypass overwrite protection.

The template contains:

- three separated framework packages, TypeScript configuration and strict compiler capabilities;
- a typed review feature with a state specification, route schemas and static AOP;
- Database First GraphQL query contracts as the recommended read path, a synthetic offline schema fixture, generated typed
  client and a deterministic client test (see [GraphQL Query Contracts](./graphql-query-contracts.md));
- a loopback-only memory demo and regression tests for permissions, idempotency,
  transaction rollback, state/version conflicts and absent runtime adapters;
- semantic watch/recompile/restart, with the last good artifacts preserved on errors;
- environment-specific templates and explicit target wrappers;
- a production application factory that requires application-supplied adapters.

Framework version ranges are embedded from the repository's package metadata at
CLI build time, so release version changes do not leave stale template literals.
New compiler and runtime fixes must be published with the CLI feature. Before
publication, `bun run scripts/check_app_starter.ts` tests locally packed artifacts
together; this is not evidence that those versions already exist on npm.

Database First is the only GraphQL server-schema model. The fixture is not an
application-owned server SDL: change Drizzle/SQL declarations, migrate, then
replace it with an intended-role database export before integration. Do not
hand-edit exported schemas or add GraphQL resolver classes. After database/grant
changes and before promotion, use `graphql-schema --check` against the selected
database, then refresh intentionally and run generated-artifact, type and RLS
checks. Offline compilation does not attest database provenance or freshness.

## Local Development Entry

`bun run dev` (the generated starter's watch/recompile/restart loop) and
`supacloud-cli app dev` share one application graph and one compiler. `app dev`
compiles, reports diagnostics and watches; it never syncs files to a remote host.
Remote test-server sync, migration generation and remote reload remain
`supacloud dev sync`, `supacloud dev migrate` and `supacloud dev watch`.

| Profile | Intended use | Requirement |
| --- | --- | --- |
| `fast` (default) | Write business code, inspect routes and check contracts quickly | Local/ephemeral dependencies; no external database is required |
| `integration` | Select a database target for subsequent integration work; this slice only compiles | An explicit `--database-url` or `SUPACLOUD_DEV_DATABASE_URL`; never inferred or defaulted |

The command reports the selected profile, project root, output directory,
database mode and current compilation result. `--once` (or `--watch=false`)
performs one compile without creating filesystem watchers. Omit these to watch.
Initial and subsequent watch reports are emitted immediately to **stderr**;
with `--format json` each progress report is one JSON line. **stdout** remains one
final JSON document when the command stops. Text output explicitly says when
watching has stopped instead of asking the user to stop an already closed watcher.

JSON reports retain `version: 1` and add `state: "once" | "watching" | "stopped"`
and `artifacts: "current" | "not-current"`. If compilation fails, `ok` is false,
`modules` and `written` are empty and artifacts are `not-current`; previous
successful generated files remain untouched, but are not presented as results
of the failed compile. The final exit status reflects the last completed compile.
Shutdown waits for an already-running recompile to finish; it does not abort a
write midway. Cancellation during startup and watcher-setup failures settle
without leaving a pending `ready` promise or live watcher behind.

Both `--database-url` and the existing `--database_url` are accepted, but not
together. The explicit flag takes precedence over `SUPACLOUD_DEV_DATABASE_URL`;
an explicitly empty flag is rejected rather than falling back to the environment.
Integration accepts only `postgres://` or `postgresql://` URLs with a host, omits
userinfo, query parameters and fragments from reports, and never echoes an
invalid URL in an error. `fast` ignores the integration environment variable and
rejects an explicit database flag rather than claiming to use it. The displayed
host and database name are metadata, not a guarantee that those names contain no
user-supplied sensitive information.

The first slice does **not** provision even a local database, connect to, migrate
or seed an integration database, start the application, or provision queue or
object-storage adapters. A syntactically valid URL does not prove connectivity,
permissions, environment identity or non-production status. Those steps require
an explicitly selected environment and remain separate follow-ups. Embedded tool
consumers can opt into `AppToolOptions.onDevProgress`; the CLI owns its stderr
transport, and the shared tool never writes to a transport implicitly.

## Environment Contract

| Target | Files | Platform target | Runtime mode |
| --- | --- | --- | --- |
| development | `.env.development`, `.env.development.local` | test | development |
| test | `.env.test` | test | test |
| staging | `.env.staging`, `.env.staging.local` | test | production |
| production | `.env.production` | production | production |

`APP_ENV` selects the application target; `SUPACLOUD_ENV` selects the platform
target. Process values override the selected files. Conflicting selectors fail.
Remote API URL, token and project ref must be complete within each file or the
inherited process profile; process credentials must also be explicitly tagged.
This prevents partial credentials from being completed with a different profile.
It does not establish credential ownership: deployments must additionally validate
the expected project and API origin.

Common `.env`, `.env.local`, legacy `dev.env` / `prod.env`, and ancestor directories
are never loaded. Bun automatic dotenv loading is disabled before wrapper execution.
`.env.test.local` is ignored and `.env.production.local` is rejected. Private env
files are ignored by Git; only examples and public synthetic test values are included.
Secrets belong in the deployment platform. `parseEnv` handles quotes and multiline
values without dollar expansion. No real credentials are generated or migrated.

```sh
bun run env:staging bun run build
bun run env:production bun run build
```

Environment wrappers launch commands without a shell and forward termination
signals and exit codes. They do not deploy.

## Production Integration

For enterprise unified identity, integrate the external SupAuth user center in
the trusted host. The production bundle exports `createSupAuthApp(identity, adapters)`,
using the runtime's `createSupAuthRequestContext` verifier. Configure HTTPS issuer,
JWKS endpoint, audience and project ID, and supply `resolveAccess` against current
application data. It constructs `requestContext` after credential verification; resolve
application-local membership and permissions separately. Never replace an
unverifiable identity with the local demo user or a service-role credential.
See [Engineering Goals](engineering-goals.md#unified-identity-contract) for
issuer/audience validation, failure behavior and cross-application acceptance.
Local compilation and deterministic tests must remain independent of SupAuth.
Use `onExecution` for metadata-only execution traces and compiler `context`/`explain`
for static plans. Real SupAuth sessions and durable database integration remain
deployment acceptance gates, not properties established by the memory demo.

`bun run build` produces `dist/application.js`, not a deployed service. Its
`createApp(adapters)` factory requires trusted request identity, a persistent
repository and command governance. The compiler and demo entry are not part of
this production entry. The memory server refuses staging and production.

Replace the example's synchronous `ReviewStore` and command with a real async
repository or transactional RPC. Lock the authoritative row or compare its
version, enforce permissions in the trusted backend, and atomically commit state,
idempotency receipt and audit. `assertFeatureTransition` checks the declared state
matrix but cannot replace any of those guarantees. Client state-machine engines
remain projections; see [Business State Machines](./business-state-machines.md).

## Acceptance Scenarios

```gherkin
Scenario: Bootstrap without credentials
  Given an empty directory and no SupaCloud credentials
  When app init creates a project and its dependencies are installed
  Then strict compilation, generated-source type checking and tests pass

Scenario: Repeat a governed transition
  Given a draft review and an authorized local identity
  When the same approval and idempotency key are sent twice
  Then both responses contain the same approved version
  And the handler and successful audit run once

Scenario: Deny unsafe writes
  Given a revoked permission, stale version or illegal state transition
  When an approval is requested
  Then the request fails without changing the stored review

Scenario: Keep environments separate
  Given production values in a common dotenv file
  When development or test is selected explicitly
  Then those values are not loaded
  And conflicting or partial inherited remote profiles are rejected

Scenario: Preserve working artifacts
  Given a running development server and successfully compiled artifacts
  When a source change violates the declared state or governance contract
  Then compilation fails without replacing the working artifacts
  And a subsequent valid change recompiles and restarts the service
```

Run `bun run scripts/check_app_starter.ts` from the repository to exercise packed
packages, actual installation, compiler/typecheck/test/build, HTTP behavior,
environment isolation, artifact drift and semantic watch/restart. The Project CLI
CI job runs this gate. It cleans up its temporary project and server.

The gate prefers cached Bun metadata (`--prefer-offline`) for dependency
installation, while still fetching missing packages on a cold cache. This avoids
unnecessary registry re-resolution of cached third-party dependencies alongside
the local tarball overrides. Each generated consumer then runs a second install
with `--offline --frozen-lockfile --ignore-scripts`; failure is fatal, not a skipped
verification. Workspace package installs retain `--frozen-lockfile`. Local
tarballs and their overrides remain the source of the candidate packages; this
is not a source-symlink shortcut.

Commands using the bounded runner report working directory, arguments and elapsed time.
A command timeout (120 seconds) reports the failing stage and is never accepted
as an expected negative test. An unresponsive child receives SIGKILL one second
after SIGTERM. A cold-cache install still requires registry availability; the
offline second pass is not evidence that an empty cache works without a network.

Run `bun test scripts/check_app_starter.test.ts` for the bounded installation
regression tests, including transitive local tarball overrides, a clean frozen
offline reinstall, and child timeout cleanup. These tests do not rebuild
workspace packages or start a database and do not replace the complete gate.
For local native PostgreSQL coverage, use
`bun --no-env-file scripts/check_app_starter.ts --postgres-bin /path/to/postgresql/bin`.
The complete gate rebuilds workspace `dist` directories; coordinate with other
active builders before running it in a shared checkout.

For a generated application's CI, commit `generated/` after initial compilation,
then run `bun run check:generated` before regenerating files, followed by
`bun run typecheck` and `bun run test`. The bootstrap `check` script regenerates
first and is intentionally not a replacement for that drift gate.
