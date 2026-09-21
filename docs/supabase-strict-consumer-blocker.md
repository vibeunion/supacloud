# Supabase Strict Consumer Blocker

Verified on 2026-09-10. Status: unresolved upstream declaration/runtime contract.

## Reproduction

The existing `packages/supacloud-js/src/consumer-artifact.test.ts` was run
unchanged in an isolated copy of `packages/supacloud-js`, with the repository's
`tsconfig.strict.json` retained at the same relative path.

Exact isolated dependencies:

- `@supabase/supabase-js`: `2.116.0`, including `@supabase/auth-js` `2.116.0`
- `typescript`: `7.0.2`
- `@types/bun`: `1.4.0`
- `@types/node`: `26.4.1`
- Bun runtime: `1.4.0`

The peer and development Supabase versions were both pinned to `2.116.0`.
Dependencies were installed with `bun install --ignore-scripts`. From the
copied SDK package, the only test command was:

```sh
bun test ./src/consumer-artifact.test.ts
```

Result: 0 passed, 1 failed, 25 assertions reached. Fresh SDK declarations,
the package's actual JavaScript build script, runtime exports and shared
official `FunctionsHttpError` identity checks completed before failure in
the external consumer compilation. Declaration generation retains its
existing `skipLibCheck` setting; it is not independent proof that upstream
declarations are valid.

The external consumer uses `skipLibCheck: false`, `strict: true`,
`exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, and
NodeNext resolution with actual peer declarations.

## Diagnostic

```text
@supabase/auth-js/dist/module/lib/webauthn.dom.d.ts(501,18): error TS2430:
Interface 'PublicKeyCredentialFuture<T>' incorrectly extends interface 'PublicKeyCredential'.
The types returned by 'toJSON()' are incompatible between these types.
The types of 'clientExtensionResults.largeBlob.blob' are incompatible.
Type 'ArrayBuffer' is not assignable to type 'string'.
```

## Repair Constraints

The installed official `auth-js` 2.116.0 source in `src/lib/webauthn.ts`
returns native `credential.toJSON()` when available. Its compatibility
branches instead copy `credential.getClientExtensionResults()` directly
into `clientExtensionResults` (registration near line 275, authentication
near lines 309-324). A declaration-only replacement of the extension output
type therefore does not establish correctness for both runtime branches.

A real repair needs to reconcile JSON serialization and exported types,
including extension binary values in both credential flows. It must then
pass the unchanged external consumer gate. A local dependency patch alone
would also not repair declarations installed independently by SDK consumers.

No workspace dependency upgrade, lockfile change, declaration patch,
ambient override, excluded declaration or relaxed compiler flag was made
for this investigation. The ordinary workspace still uses Supabase 2.115.0.
The isolated test does not establish real-browser WebAuthn behavior or
production compatibility, and the full type-safety goal remains incomplete.
