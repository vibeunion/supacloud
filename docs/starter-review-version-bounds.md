# Review Version Bounds

The starter's existing PostgreSQL review version column is a positive `integer`.
The maintained `src/review/limits.ts` declares its upper bound, 2147483647.
Approval, upload and receipt contracts share `ReviewVersion`; task contracts and
browser submission checks use the same bound. This is an explicit mapping of
the existing database type, not an automatic database migration.

## Acceptance

- Given a draft at version 2147483646, when approved, then version 2147483647,
  its receipt and audit commit together; same-key replay still succeeds.
- Given a draft already at 2147483647, when approved, then a business conflict
  occurs before any write, receipt or audit, rather than integer overflow.
- Given an HTTP input above the database range, when validated, then it is
  rejected before business execution, not returned as an unknown database outcome.
- Given an exhausted or out-of-range browser row, when approval is requested,
  then no pending marker or write is created.
- Given an old out-of-range persisted marker, when loaded, then the client stays
  blocked and preserves the original evidence rather than deleting or replacing it.
- Given an attachment task input or result outside the database version range,
  when decoded using the generated contract, then it is rejected.
- Given an approved review at the maximum version with a bound attachment, when
  its worker runs, then the durable result and task status still complete normally.

## Adoption

Adopt the new limits source together with the updated contracts, review handler,
task contracts, attachment job, upload host and browser client; include it in isolated browser test fixtures.
Regenerate the compiled client and OpenAPI normally. No historical SQL migration
is edited, and no data or idempotency keys are rewritten.

Existing valid persisted markers keep their format. Out-of-range markers cannot
represent a valid PostgreSQL review version; they require explicit investigation,
not automatic deletion. Lookup and upload still accept the maximum valid version;
only a new approval increment at that version is disallowed.
The upload host casts the expected version to `bigint` for its `+ 1` comparison
so a maximum-version receipt lookup cannot overflow. This widens only the
comparison arithmetic, not the stored column or accepted version range.
The attachment input and result schemas share this maximum as well. This guards
the worker boundary; it does not prevent privileged callers from inserting
invalid Workflow messages. Those messages fail validation rather than execute.

To support more versions, use a separately reviewed database/type migration and
precision policy. Raising the JavaScript constant alone is not sufficient.

Verification uses the single `packages/elysia/src/starter-task-lifecycle.test.ts`
file with disposable native PostgreSQL. Storage responses, list refresh and
local signing keys retain the reference fixture boundaries; this is not customer
deployment or real-browser acceptance.
