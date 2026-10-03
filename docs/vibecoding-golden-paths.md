# Vibecoding Golden Paths

[English](vibecoding-golden-paths.md) | [简体中文](vibecoding-golden-paths.zh-CN.md)

Status: supported defaults with explicit compatibility recipes; live acceptance
and publication remain separate from source implementation.
Implemented changes and their verification boundaries are recorded in the
[local acceptance report](vibecoding-acceptance.md).

## Outcome

SupaCloud borrows Angular's *engineering experience* — one entry point, strong
conventions, generators, early compiler feedback and actionable diagnostics —
without introducing NgModule or another general application framework. Existing
metadata helpers retain their Angular-backed integration; compiled factories and
platform capabilities stay SupaCloud-native.

> Angular is a developer-experience reference and an existing metadata dependency,
> not a requirement to adopt its frontend framework. The goal is a constrained, diagnosable and
> deliverable pipeline.

## Quick start

```bash
supacloud-cli app init --root ./orders-api --name orders-api   # minimal; explicit recipes
cd orders-api && bun install && bun run check

supacloud context --format json > context.json   # AI reads the compiled project graph
supacloud doctor --format json > doctor.json     # actionable diagnostics + fix plan
supacloud fix --fix fix.json --write             # apply one DiagnosticFix, then recheck
```

## Single entry point

Developers and AI use one CLI surface and do not need to remember the underlying
packages:

```bash
supacloud-cli app init        # minimal project; src/features/<feature>
supacloud-cli app dev         # run the project's existing local dev script
supacloud-cli app watch       # compiler-only watch
supacloud-cli app verify-plan --target health  # focused tests, never a full-suite fallback
supacloud generate ...        # generators
supacloud check               # compiler governance checks
supacloud context --format json
supacloud doctor              # actionable health report
supacloud fix --fix fix.json  # apply a DiagnosticFix (preview; --write to apply)
supacloud deploy              # delivery
```

The `app` namespace remains as the low-level form (`supacloud app <verb>`); the
top-level verbs are aliases with the same implementation and execution policy.

> `app dev` delegates to `bun run dev` (watch, compile, restart).
> `supacloud-cli dev ...` is the separate remote project
> sync/watch/migrate module; they are different commands.

## Conventional project structure

The target is a fixed, AI-legible layout so an agent can locate the entry,
business modules, generated files and protected files without scanning:

```text
src/
  application.ts # host factory
  app.module.ts  # application composition
  features/   # business slices with colocated tests
  shared/     # tokens, cross-module contracts and utilities
generated/    # compiler output (do not hand-edit; checked for drift)
supacloud.config.ts
```

The minimal starter and generators use `src/features/`. Explicit reference
recipes retain `src/review/`, `src/orders/` and `src/sync/` for compatibility.
Do not move existing application files only to adopt this default.
Ordinary reads use the existing RLS-protected PostgREST client; GraphQL remains
an opt-in contract pipeline and part of the explicit command reference.

`generated/**` is produced by the compiler and is intentionally committed so
`supacloud check` can detect drift. Never edit `generated/**` directly.

## Generator-first

Common tasks have stable, re-runnable generators whose output is readable,
editable and repeatable — never a black box:

```bash
supacloud generate --kind module   --name orders
supacloud generate --kind controller --module orders
supacloud generate --kind command  --module orders --name accept
supacloud generate --kind query    --module orders --name list
supacloud generate --kind job      --module orders --name sync-orders
supacloud generate --kind contract --module orders --name accept
```

## Compiler does more of the reasoning

The compiler reports statically provable mistakes earlier than runtime or AI
guesswork: module dependency errors, scope misuse, route/schema mismatch, missing
command permission/transaction/idempotency, generated-artifact drift, illegal
cross-layer references and unconfigured provider capabilities.

## AI-native context

`supacloud context --format json` returns the compiled module graph, providers,
routes/commands/jobs, diagnostics and the commands an agent should run. A
`--target <name>` narrows the result to one module neighborhood. Targets may be
module names/classes or owned provider, controller, command, job and query names.
The returned `subject` remains the canonical module name; ambiguous owners require
an explicit module target. Existing module queries keep the same version-1 shape.
Agents read
structured context instead of scanning the repository, and never receive
credentials or live user data.

## Three golden paths

The minimal default precedes these opt-in recipes; it does not install all three.
New business metadata uses `@supacloud/app/core`, while the frontend continues to
use `@supacloud/js` with its existing Supabase session and selected UI framework.

Support a small number of stable paths first, each with a template, generator,
example, tests and a deployment flow:

1. **HTTP API** — controllers, route contracts and request/response validation.
2. **Database transaction and Command** — durable authorization, idempotency,
   transaction and audit.
3. **Worker / Edge** — background jobs and edge functions with explicit
   governance boundaries.

Do not try to support every combination at once, and do not add a package per
capability.

## Executable diagnostics

`doctor` returns more than "failed": a stable code, file/line, reason, repair
suggestion, a complete `fix` payload, and a preview command. Each `fixPlan` entry
has a `readiness` and `reason`:

- `preview`: supported by the executor with explicit policy inputs present.
- `input-required`: requires a permission, policy value, or concrete module import.
- `manual`: the executor does not implement the suggested semantic change.

The existing `autoFixable` count now counts only `preview` entries; `inputRequired`
and `manualFixes` report the other suggestions. This corrects the old count, which
included suggestions the executor could not apply. A preview-ready classification
does not bypass AST checks, grant write permission, or prove business correctness.
An invalid policy is never automatically replaced with a weaker one.

```bash
supacloud context --format json > context.json
supacloud doctor --format json > doctor.json
supacloud fix --fix fix.json          # preview
supacloud fix --fix fix.json --write  # apply
```

## Compatibility And Release

### Shared Business Command Wiring

`@supacloud/elysia` also offers opt-in `bindCompiledCommand`: a reusable binding
for the compiled module, command class name, governance, handler and result
decoder. HTTP controllers, Worker jobs and trusted server-side callers provide
their current input, Request, verified identity context and scope on each call.
The binding delegates to the existing direct execution/preview APIs; it does
not replace route bindings, add a queue engine, or centralize business policy
outside its owning module. See the
[runtime example](../packages/elysia/README.md#bind-a-command-once).
An explicitly supplied preview callback makes `preview` required in the inferred
return type; dynamically optional preview configuration still requires narrowing.

Do not wrap the same operation in both a route command binding and a direct
bound call. Domain validation and host identity verification remain explicit.
In-memory adapter parity proves execution behavior, not database atomicity.

### Inspection Compatibility

The inspection increment changes development inspection only. It does not change runtime
DI, authorization, transactions, queues, frontend transports, deployment topology,
or existing configuration and generated artifact formats.

The CLI uses the local compiler during development so its tests exercise the
matching implementation. Before publishing, release the compiler and use the
existing `sync-compiler-dependency.mjs` release step to replace the local reference
with the published version range. A local paired build is not an npm publication
or production acceptance receipt.

## Non-goals

- Do not copy Angular's NgModule or decorator system.
- Do not add packages to look complete.
- Do not build one giant package with every runtime capability.
- Do not make AI depend on implicit conventions or internal APIs.
- Do not maintain multiple schema, permission or migration sources of truth.
