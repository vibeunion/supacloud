# SupaCloud development rules

## Start here

- Feature iteration: [docs/feature-development.md](docs/feature-development.md).
- AOP design and framework references: [docs/architecture/static-aop.md](docs/architecture/static-aop.md).
- Breaking database adoption: [docs/architecture/zenstack-upgrade.md](docs/architecture/zenstack-upgrade.md).
- Check the implementation and executable examples linked by these guides before extending a boundary. Distinguish implemented enforcement from proposed work.

## Scope and verification

- Preserve unrelated work in shared checkouts. Change only the requested feature and its necessary contracts, generated artifacts, documentation and regression coverage.
- Do not perform repository-wide refactors, formatting or type rewrites for a local change. Do not introduce `any` or `@ts-ignore`.
- For daily code changes, run one directly relevant test file and `git diff --check`. Use only focused generation/type/build checks needed by the changed contract. Do not run full suites, `test:standalone` or `verify:standalone` in a daily task.
- Documentation-only edits need link/source consistency checks and `git diff --check`; do not add tests that merely restate prose.
- Report local verification, push, merge, publication, migration and deployment separately. A generated plan or passing compile is not runtime or deployment evidence.

## Architecture defaults

- Primary references: Micronaut for compile-time AOP/DI analysis and direct code generation; NestJS for feature Module/Provider/Controller organization; Angular for constructor token, modifier, alias/multi and lifecycle semantics. The supported server profile is documented in `docs/architecture/static-aop.md`.
- Keep feature providers private unless explicitly exported; re-export through declared imports. Request/job providers remain in their owning feature, and share application ports across features. Optional missing dependencies are `null`; use parameter-level modifiers and nullable types.

- Organize application work by feature. Keep TypeBox public contracts, ZModel data structure/policies and ordinary TypeScript domain rules in their respective owners.
- New server-side model reads use an identity-bound read facade; model writes use the existing durable Command transaction. Existing PostgREST/RPC paths retain role-scoped contracts and RLS; ZenStack policies do not protect those paths.
- Trusted hosts verify identity and bind the database/store. Business handlers receive `transaction.db`; do not expose raw clients, identity setters, nested transactions or policy controls. Keep `trustedHosts` narrowly scoped.
- Use explicit compiled module/route/command/job aspects and constructor injection. Do not add runtime pointcut discovery, method proxies, reflection containers, arbitrary method interception or a second governance pipeline.
- Prefer `defineOperationAspect` with operation-specific validators and minimal selected capabilities. Command aspects must return the actual continuation result and preserve failures; use plain immutable result data. Start new model-backed HTTP/Worker features from `app init --template model-command` and follow its identity/migration setup.
- Durable Command adapters own authorization, receipt replay, transaction and audit. An aspect must not create another transaction, ledger or automatic write retry. Reuse the governed entry for HTTP, workers and trusted CLI calls.
- Effect owns execution composition and typed failures. Follow the compiler's Effect contracts and keep production interpretation in the framework adapter. Pure domain functions remain ordinary TypeScript.
- Keep strict compiler defaults and offline database governance `check` enabled for adopted model applications. Bind persistent capabilities to real adapters. Do not weaken checks to make a feature compile; document any intentional migration exception and its boundary.
- Generate model/contracts from maintained sources and commit the results together. Review forward SQL candidates and use the existing migration ledger; never rewrite applied migrations or introduce a second migration executor.
- Use the framework references as design input, not API compatibility commitments. Reference choices do not by themselves authorize replacing Angular, Elysia, Effect or the compiler runtime.
