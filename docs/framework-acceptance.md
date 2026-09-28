# Framework Acceptance Before Consumer Adoption

This gate covers the supported framework boundary, not feature parity with all
Angular or Elysia capabilities. Acceptance must report actual executions; a
skipped database test is not success.

## Supported Baseline

The recorded tuple is Bun 1.4.2, Elysia 1.4.30, TypeBox 0.34.52,
TypeScript CLI 7.0.2 and TypeScript semantic API 6.0.2.
`packages/elysia/compatibility.json` is checked against installed versions.
Dependency upgrades must update this tuple deliberately and rerun the gates.

Native HTTP schema decoding, status responses, parent lifecycle order and local
plugin encapsulation are compared against native Elysia. Public error envelopes,
response-validation HTTP 500, decoded cookie values and request providers are
SupaCloud semantics. Unsupported compiled methods/native hook fields fail at
registration; browser navigation guards cannot silently become server policy.

WebSockets, signed-cookie mutation, arbitrary plugins, streaming/disconnect
semantics and alternate runtimes are outside this baseline. TypeBox request
transforms are exercised as wire strings decoded to numbers. Generated response
decoders do not support TypeBox response transforms; they must fail explicitly,
not claim a decoded type from an unchecked value.

## Focused Evidence

Run each file independently from the indicated package. Do not replace these
assertions with snapshot updates or broad test-count claims.

| Requirement | Package and focused gate | Evidence |
| --- | --- | --- |
| Supported tuple and rejected descriptors | elysia: `bun run test:conformance` | Version readback, unsupported method/hook rejection |
| Elysia consistency | same gate | Side-by-side native HTTP behavior and documented intentional differences |
| Runtime safety | elysia: `bun run test:runtime-safety` | Real loopback HTTP and PostgreSQL; overlapping identities, isolated providers, teardown, denied writes, replay isolation, rollback and same-key retry |
| Types, generated runtime and OpenAPI | elysia: `bun run test:contract-upgrade` | Actual compiler, generated client, real HTTP, nullable/optional fields, wire transforms, status union, positive and negative checks in both TypeScript engines |
| Versioned migration | compiler: `bun test src/migrations.test.ts` | Registry path selection, dependency rejection, preview, idempotence, conflicts, simulated write failure and recovery |
| Upgrade and restore | elysia: `bun run test:contract-upgrade` | Fixed legacy source fixture upgraded and executed; source checkpoint restored, artifacts regenerated, restored handler exercised |

Build local contracts and app JavaScript/declarations, compiler JavaScript/
declarations, and commands/db JavaScript before installing elysia's local file
dependencies. Bun may copy those dependencies; reinstall after upstream builds.
This is source acceptance, not a packed-npm artifact acceptance claim.

## Database Boundary

Provision a dedicated local PostgreSQL 18 container with PGMQ 1.10.0 and database
`supacloud_commands_test`, bound only to `127.0.0.1`. Set
`SUPACLOUD_COMMAND_TEST_URL` for that instance and run
`bun scripts/prepare-command-test-database.ts` from the repository root.
The runtime gate rejects other database names/hosts and requires the URL.
It uses a fixed token map for authentication; JWT verification and application
RLS rules need separate domain tests. Stop the temporary container after use.

## Migration Policy

`--from-version 0.11.0 --to-version 0.12.0` selects source-format checkpoints,
not package versions. Unknown checkpoints, reverse/ambiguous paths and untested
installed dependencies block writes. The compatibility tuple is intentionally
narrow; expanding it requires new execution evidence, not a permissive range.
Unversioned migration remains a mechanical compatibility entrypoint and does not
attest package compatibility.

File replacements check for intervening source changes and retain only the final
content of successive migrations. On a later write failure, earlier writes are
restored only when they still match the migrator's output. Failed rollback is
reported with the residual changed paths, never hidden as an empty change set.
Process crashes are not transactionally recoverable: create a clean source
checkpoint before writing, and restore source and generated artifacts together.

The old `response` field is a temporary 200-response bridge. Remove it only in an
explicit breaking release after the versioned migration is available, maintained
fixtures use `responses`, and consumer upgrade/rollback has been accepted. Do not
silently remove it in a patch release or promise an unannounced removal date.

## Remaining Delivery Evidence

This scope deliberately excludes packed-package installation, historical npm
release combinations, production authentication, consumer business correctness
and deployment acceptance. Those remain distinct gates; passing this baseline
does not justify claiming complete Angular/Elysia alignment.

## Local Execution Record

On the baseline recorded above, focused executions completed with:

- Conformance: 17 tests, 59 assertions.
- Real HTTP/PostgreSQL safety: 4 tests, 53 assertions.
- Migration: 12 tests, 59 assertions.
- Contract upgrade/restore: 1 end-to-end test, 26 assertions.
- Compiler public API snapshot: matches the reviewed addition of optional
  `fromVersion` and `toVersion`.

The PostgreSQL instance reported 18.1 with PGMQ 1.10.0. No remote test or
production database was used. No full repository test suite was run; these counts
are evidence for the focused scenarios above, not a release-wide acceptance.
