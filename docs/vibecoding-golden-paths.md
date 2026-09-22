# Vibecoding Golden Paths

[English](vibecoding-golden-paths.md) | [简体中文](vibecoding-golden-paths.zh-CN.md)

Status: target engineering experience, not a completion claim.

## Outcome

SupaCloud borrows Angular's *engineering experience* — one entry point, strong
conventions, generators, early compiler feedback and actionable diagnostics —
without copying NgModule, its decorator system or its package sprawl. The runtime
and platform capabilities stay SupaCloud-native.

> Angular is the reference for developer experience, not for technical
> implementation. The goal is to make Vibecoding a constrained, diagnosable and
> deliverable pipeline.

## Quick start

```bash
supacloud app init --name orders-api --template http   # or command / edge
cd orders-api && bun install && bun run check

supacloud context --format json > context.json   # AI reads the compiled project graph
supacloud doctor --format json > doctor.json     # actionable diagnostics + fix plan
supacloud fix --fix fix.json --write             # apply one DiagnosticFix, then recheck
```

## Single entry point

Developers and AI use one CLI surface and do not need to remember the underlying
packages:

```bash
supacloud app init            # scaffold a project
supacloud dev                 # local run loop
supacloud generate ...        # generators
supacloud check               # compiler governance checks
supacloud context --format json
supacloud doctor              # actionable health report
supacloud fix --fix fix.json  # apply a DiagnosticFix (preview; --write to apply)
supacloud deploy              # delivery
```

The `app` namespace remains as the low-level form (`supacloud app <verb>`); the
top-level verbs are aliases with the same implementation and execution policy.

> In a generated project, the local development loop is `bun run dev` (watch,
> compile, restart). `supacloud dev ...` is the separate remote project
> sync/watch/migrate module; they are different commands.

## Conventional project structure

New projects use a fixed, AI-legible layout so an agent can locate the entry,
business modules, generated files and protected files without scanning:

```text
src/
  app/        # application entry and wiring (protected: generated imports)
  modules/    # business modules (feature slices)
  shared/     # tokens, cross-module contracts and utilities
generated/    # compiler output (do not hand-edit; checked for drift)
supacloud.config.ts
```

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
`--target <module>` narrows the result to one module neighborhood. Agents read
structured context instead of scanning the repository, and never receive
credentials or live user data.

## Three golden paths

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
suggestion, whether it is auto-fixable, and the command to apply the fix.

```bash
supacloud context --format json > context.json
supacloud doctor --format json > doctor.json
supacloud fix --fix fix.json          # preview
supacloud fix --fix fix.json --write  # apply
```

## Non-goals

- Do not copy Angular's NgModule or decorator system.
- Do not add packages to look complete.
- Do not build one giant package with every runtime capability.
- Do not make AI depend on implicit conventions or internal APIs.
- Do not maintain multiple schema, permission or migration sources of truth.