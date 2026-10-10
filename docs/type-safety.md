# Type Safety Gate

This repository treats compile-time type safety as a frozen merge gate over
**production authored source**. A green gate is 100% of that contract. It is not a claim
of mathematical TypeScript soundness, runtime correctness, or third-party
declaration quality.

## Merge contract

`bun run check:type-safety` must pass.

SupaCloud application compilation always checks selected production source under
TypeScript strict mode and the additional indexed-access, optional-property,
override, index-signature and switch-fallthrough checks. Explicit or inferred
`any` reported in this source, and explicit `any` in generated artifacts, are
errors even with `strict: false` or disabled `typeSafety` toggles. Type errors
preserve existing artifacts even with `writeOnError: true`. Incremental runs
recheck these gates, including enclosing configuration and imported declarations.
Scan exclusions and third-party declarations remain scope boundaries; this is
not a proof that all possible `any` flows or excluded files are safe.

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
