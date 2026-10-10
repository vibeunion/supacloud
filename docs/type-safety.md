# Type Safety Gate

This repository treats compile-time type safety as a frozen merge gate over
**production authored source**. A green gate is 100% of that contract. It is not a claim
of mathematical TypeScript soundness, runtime correctness, or third-party
declaration quality.

## Merge contract

`bun run check:type-safety`, `bun run check:platform-source` and
`bun run check:strict-governance` must pass.

SupaCloud application compilation always checks selected production source under
TypeScript strict mode and the additional indexed-access, optional-property,
override, index-signature and switch-fallthrough checks. Explicit or inferred
`any` reported in this source, and explicit `any` in generated artifacts, are
errors even with `strict: false` or disabled `typeSafety` toggles. Type errors
preserve existing artifacts even with `writeOnError: true`. Incremental runs
recheck these gates, including enclosing configuration and imported declarations.
Scan exclusions and third-party declarations remain scope boundaries; this is
not a proof that all possible `any` flows or excluded files are safe.

## Application semantic checks

- `SC6009` rejects checked `any` flows into concrete assignments, arguments and
  returns, including type assertions. It also checks application aliases, generic
  arguments, inferred DTOs, class fields and locally declared function signatures.
  Quarantine untrusted results as `unknown`, then narrow or decode them.
- `SC6010` rejects bare Promise/PromiseLike statements and `void promise`.
  Await or return the work, or provide a callable rejection handler using `catch`
  or the second argument of `then`. This is a rejection-handling check, not a
  proof of cancellation ownership or runtime resource limits.
- `SC6011` requires explicit coverage of every finite literal-union switch member.
  A `default` branch does not replace missing cases. Open string/number domains
  are not finite-union exhaustiveness checks.
- `noCheck` cannot disable the mandatory TypeScript gate.

Application properties and function signatures are inspected under the selected
source root. Library class instances and declaration internals are boundary types,
not recursively verified application DTOs. Direct `any` and generic `any` results
are checked at use sites, but excluded declarations can still hide nested unsafe
types. This does not add Rust ownership, borrowing or whole-program soundness.
User compilation and official starters enforce the stronger baseline. Shared
production configurations and repository tooling also enable strict indexed
access, optional-property, override, index-signature, catch-variable and
switch-fallthrough checks through `tsconfig.strict.json`.

## Platform source policy

`bun run check:platform-source` parses authored TS/JS source under `packages/*`
and `scripts`, plus Svelte scripts and template expressions. Explicit `any` and
type-checking suppressions are forbidden. There is no compatibility allowlist,
audited-debt baseline or per-file production waiver.

Test/spec files, fixture directories, generated output, build output and
third-party dependencies are separate boundaries. `.typecheck.` negative
contracts may use `@ts-expect-error`; they still cannot use explicit `any`,
`@ts-ignore` or `@ts-nocheck`. This source-policy gate does not prove the absence
of every inferred `any` from third-party declarations; production typechecks
and the application compiler's semantic gates remain necessary.

## Repository inventory

- Every package's production `tsconfig.json` is checked. The gate reports the
  files selected by those configs; it does not invent a repository-wide source
  coverage percentage from unrelated test or fixture files.
- Production TypeScript, Svelte, and checked JavaScript selected by the
  configs are compiled.
- `strict` and `skipLibCheck` are true. Third-party `.d.ts` and `node_modules`
  source are out of scope.
- Console diagnostics are counted only for this repository's files.
- The SDK consumer check compiles against this SDK's declarations and the
  local Supabase stub. It does not typecheck `@supabase/auth-js` internals.

`bun run test:type-safety` runs the inventory tests and the same production
gate. Package test typechecks and runtime test behavior remain separate.

## Out of scope

These are not type-safety remaining work and must not block this gate:

- Git protocol / transport policy
- Browser memory erasure or heap inspection
- Full realtime protocol compatibility
- All third-party receipts, declarations, and vendor `.d.ts` files

## Runtime follow-ups

Untrusted JSON, network, and database values still need decoders on high-risk
product surfaces. That work is separate, sliced by risk, and is not a leftover
item on this gate:

1. Queues
2. Hosting / deployment configuration
3. Authentication / session

Do not scan the whole repository for new runtime boundaries unless a product
risk requires it.
