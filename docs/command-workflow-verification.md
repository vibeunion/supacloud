# Command / Workflow Verification

Date: 2026-09-09. Isolated worktree on top of `18374b58`, based on main
`18f84be7`. This report supersedes the pre-convergence verification record.
No customer repository, production database or npm publication is included.

## Package Gates

`bun run verify:commands` passed against a disposable database running PostgreSQL
18.1 and PGMQ 1.10.0 (`ghcr.io/pgmq/pg18-pgmq:v1.10.0`). The suite installs the real
existing Workflow/Commands SQL, not a mock queue.

| Package | Source types | Test types | Tests | Build |
| --- | --- | --- | --- | --- |
| contracts | pass | pass | 38 | pass |
| commands | pass | pass | 13 | pass |
| db | pass | pass | 101 | pass |
| app | pass | pass | 178 | pass |
| compiler | pass | pass | 281 | pass |
| app-svelte | pass | pass, Svelte 0 errors/0 warnings | 1 | pass |
| supacloud-js | pass | pass | 28 | pass |
| elysia | pass | pass | 108 | pass |

748 package tests passed with no native database tests skipped. Additional gates:

- 21 package-publication/workflow script tests.
- 11 SQL-module synchronization tests; generated native and Lite SQL match.
- 1 PGlite command/artifact integration test through actual SDK serialization.
- SupaCloud Lite source/test typecheck and build.
- Strict tool typecheck and strict command-specific db/SDK typecheck projects,
  including noUncheckedIndexedAccess, exactOptionalPropertyTypes and skipLibCheck=false.
- SDK NodeNext consumer declarations, including contracts root/client/browser.
- 18-package architectural boundary check and git diff --check.

Total: 781 automated tests. Package runner logs are local regenerable artifacts
`output/command-migration/01.log` through `48.log`; they are not production receipts.
The actual Chromium lifecycle harness also passed all 10 assertions after the
contract export changes. Local screenshot:
`output/playwright/command-workflow-regression.png`. This is not customer SvelteKit
or identity-provider end-to-end acceptance.

## Behavioral Evidence

Native PostgreSQL/PGMQ tests cover:

- External intent and recovery enqueue commit together; enqueue failure rolls
  back intent and prevents all external sends.
- A submitted operation keeps its original command ID and Workflow run. Tenant,
  actor, command, original input and current Workflow attempt are verified.
- A bound transactional command rolls back business and Workflow completion if
  audit fails, and same-key replay commits only one business write.
- A bound external command advances execute to reconcile in the same transaction
  as intent, then uses the original dispatch ID for its single send.
- Workflow redelivery only reconciles/finishes audit. Stale acknowledgements fail;
  independent worker authorization does not impersonate the original actor.
- Retry-budget exhaustion fails the Workflow while preserving unknown business
  state; no redispatch occurs.
- Unified lookups resolve command ID or full operation reference, reject malformed
  or ambiguous selectors, and remain inaccessible to the authenticated role.
- Submission replay cannot create a second command under a direct execution's ID.
- Redacted completed inputs do not prevent delayed recovery acknowledgement.
- Prototype migration backfills one workflow per unresolved operation, preserves
  identity/input/fingerprint, drops old scanner columns and can run twice.

## Type and Delivery Limits

Existing projects retain their main-branch compiler settings. The new db/SDK
command-specific projects check the modified boundaries with stricter options;
this does not claim repository-wide migration to those settings.

The existing NodeNext consumer fixture uses a minimal Supabase declaration stub.
It verifies SDK/contracts declaration compatibility, not every third-party DOM
declaration. The production command client uses a narrow RPC port and validates
unknown response data; it does not use the older generic response assertion.
Other existing SDK clients were not globally rewritten.

The native integration job is now a dependency of Required Checks. Local execution
does not establish that GitHub Actions, production workers, Windows/native Lite,
or a customer deployment have passed. No branch-protection bypass is authorized.

The host must still deploy its existing dispatcher, register execute/reconcile
handlers, apply application permissions, configure timeouts/monitoring and review
legacy identity backfills. No cross-service atomicity or measured maintenance-cost
reduction is claimed. See [migration](./command-workflow-convergence.md).
