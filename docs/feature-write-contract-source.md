# Feature Write Contract Source

The feature generator derives the Writer input from the approval body contract
and the route ID. It no longer repeats the body fields in the Port signature.
The service continues forwarding the body with the authoritative route ID.
Database models and HTTP contracts retain their separate ownership.

## Acceptance

- Given an optional field added to the approval body schema, when the generated
  application is typechecked, then the Writer receives its inferred type without
  editing the model or service.
- Given that field changes from string to integer, when an adapter still assumes
  string, then TypeScript reports the error in the business adapter.
- Given a feature lacking its named persistent RPC capability, when compiled,
  then compilation still rejects it. Input derivation does not supply storage,
  authorization, idempotency or audit implementations.

## Adoption

New feature scaffolds include the derived command-input alias. Existing features
should replace their duplicated Writer input with their approval input type plus
the route ID and typecheck their adapters. The CLI does not overwrite existing
application files. No database migration is required.

Verification: the single `app-feature-generation.test.ts` exercises generation,
compiler capability checks, generated service tests, strict TypeScript and
contract-change diagnostics. These are local generator checks, not customer
database integration or deployment acceptance.
