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

The project CLI binary also supports `supacloud-cli app init`. Initialization is
local, needs no account or API token, never installs dependencies automatically,
and refuses non-empty or symlink targets. A `.git` directory is allowed. `--force`
does not bypass overwrite protection.

The template contains:

- three separated framework packages, TypeScript configuration and strict compiler capabilities;
- a typed review feature with a state specification, route schemas and static AOP;
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

For a generated application's CI, commit `generated/` after initial compilation,
then run `bun run check:generated` before regenerating files, followed by
`bun run typecheck` and `bun run test`. The bootstrap `check` script regenerates
first and is intentionally not a replacement for that drift gate.
