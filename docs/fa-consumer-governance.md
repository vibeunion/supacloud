# FA Consumer Governance

## Ownership

SupAuth remains the external user center. SupaCloud verifies credentials, compiles
declarations, runs explicit adapters and reports boundaries. FA owns membership,
object authorization timing, RLS, state transitions, database transactions,
idempotency receipts and business audit. No second ledger is introduced.

## Acceptance Scenarios

```gherkin
Scenario: Application-bound identity
  Given a signed SupAuth token for another client or a non-user role
  When the request context is created
  Then authentication fails before membership lookup
  And a verification service outage instead produces a sanitized 503

Scenario: Direct command execution
  Given a compiled command and a named RPC adapter with required capabilities
  When domain code executes it at its chosen authorization boundary
  Then authorization precedes aspects and the handler runs at most once
  And no framework receipt or audit write duplicates the RPC

Scenario: Honest contracts
  Given an opaque body schema or a native Response
  When a module context pack is inspected
  Then declaration, domain ownership and remaining runtime obligations are visible
  And no declaration is marked verified

Scenario: Uncertain outcome
  Given a valid command whose response is lost or cannot be decoded
  When the contract client attempts confirmation
  Then it performs at most one read-only lookup and never repeats the write
  And a mismatched or missing receipt remains unknown

Scenario: Real consumer compatibility
  Given the current FA source snapshot and packed candidate packages
  When the isolated candidate gate migrates deletion to the POST command protocol
  Then compilation, artifact drift checks and consumer regressions pass
  And the original FA checkout and dependencies remain unchanged
```

## Direct Execution

`executeCompiledCommand` from `@supacloud/elysia` selects exactly one compiler
descriptor by class name. Supply the generated module, input, request/context,
application-owned `governance`, a handler and a result decoder. It does not create
request scopes or bind HTTP routes: the caller owns scope lifetime and chooses
the authorization boundary. Do not wrap an already-governed `command.execute()`;
pass the business handler to avoid double governance.

The descriptor may declare `rpc: "approve_case"`. The compiler requires
`commandCapabilities.rpc.approve_case` with explicitly true audit, transaction
and idempotency capabilities whenever those are required. The runtime requires
the same named `governance.rpc.approve_case` adapter with `capabilities` and
`execute(invocation, next)`. Its continuation is single-use. Ordinary framework
audit/transaction/idempotency adapters are not also run for that command.
These capability declarations are assertions by the host, not database proof:
test the actual RPC transaction, receipt uniqueness, authorization and audit.

`context <module> --json` contains direct-command execution plans and
`routeContracts`. Contract labels are declarative. `Type.Unknown()`/`Type.Any()`
and typed native Responses are conservatively identified; arbitrary wrappers
cannot be proved by this analysis. Use route `contract` to document body owner,
response transport and the relevant test file. Binary/stream transports do not
need JSON schemas and must never be consumed by a global JSON decoder.

New diagnostic identifiers: `SC4013` rejects dynamic/empty RPC names, `SC4014`
rejects missing named adapters, and `SC3020` rejects unsupported contract owner
or transport labels. Capability registration is a host decision and is not
automatically repaired by weakening governance.

## Browser Client

Import `createContractCommandClient` from `@supacloud/app/contracts`. This isolated
browser build has no Angular, server SDK, credentials or Node dependencies.
Provide request/result decoders (for example TypeBox-backed functions), `send`,
an optional read-only `lookup`, and `matches(input, result)` to enforce domain
request/entity/command binding. The result is a discriminated `confirmed` or
`unknown` outcome. A confirmed receipt identifies whether it came from the
response or lookup. Optional `isDefinitiveFailure` preserves application-classified
denials without lookup; never classify ambiguous network failures as denials.
Do not install a retrying transport beneath this helper.

## Candidate Gate

Run from SupaCloud:

```sh
bun --no-env-file scripts/check_fa_consumer.ts /absolute/path/to/xigu-fa
```

The gate copies current source files, including uncommitted source, into a
temporary directory, packs app/compiler/runtime, installs them only there,
applies `scripts/fixtures/fa-candidate.patch` to SOURCE, compiles twice and runs
representative consumer tests. It records source/package hashes, never patches
generated invokers, and deletes the temporary directory. It does not load .env,
SSH, run migrations, contact the production user center or deploy.

The migration replaces `DELETE /config/qualifications/:id` with
`POST /config/qualifications/:id/delete`, updates the browser caller and tests,
and uses `@Body()` with `DomainValidatedBody`; invalid domain fields remain FA 400
errors. DELETE bodies remain forbidden, with no opt-in or legacy alias.
Notify FA to apply the source migration when adopting the candidate packages.
The original FA checkout is not automatically upgraded by the gate.

This gate establishes local compatibility, not full FA release readiness. A real
FA upgrade additionally requires its stack, frontend typecheck, function bundle,
build and standalone gates, plus approved PostgreSQL and live SupAuth acceptance.
Passing fake-backed consumer tests does not establish database behavior or
publication/deployment status.
