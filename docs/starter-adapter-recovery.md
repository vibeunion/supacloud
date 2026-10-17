# Starter Adapter Recovery

The generated review client validates write outcomes even when a custom
`ReviewTransport` violates its TypeScript return type. Invalid outcomes become
`unknown`; they never clear the pending marker or permit a replacement write.

## Acceptance

- Given an approval or upload, when the adapter returns null, an unknown status,
  a malformed receipt or a throwing accessor, then the original operation stays
  pending and a second submission performs no write.
- Given a pending operation, when lookup returns an invalid result, denial or
  conflict, then it remains pending. Lookup failure cannot establish that the
  original mutation did not commit.
- Given a pending operation, when lookup returns a matching confirmed receipt,
  then the client clears the matching marker and refreshes once without replay.
- Given a valid initial denial or conflict, when the adapter returns it, then
  existing rejection handling is unchanged.

## Adoption

New command starters include this guard. Existing generated applications must
update their `src/client/reviews.ts` state machine and rerun their client tests;
upgrading the CLI alone does not rewrite application-owned files. No database
migration or pending-storage format change is required.

This validates result shape and correlation, not server authenticity. A trusted
adapter and server-side authorization remain required. The tests exercise the
generated client and strict TypeScript boundary, not a deployed browser or
customer acceptance flow.
