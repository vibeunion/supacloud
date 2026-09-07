# @supacloud/app

Angular-style application metadata for SupaCloud applications: modules, DI
tokens, providers, scopes, controllers and commands.

This package is **metadata only**. Decorators attach metadata to classes; the
SupaCloud compiler (`@supacloud/compiler`) reads that metadata from source,
validates the dependency graph and generates plain static factories — there is
no runtime reflection and no `reflect-metadata` dependency.

## Zero-configuration start

For a complete runnable project, use `supacloud-cli app init --root ./orders --name orders`,
then `bun install`, `bun run check` and `bun run dev` inside `orders`.
The template includes compiler, Elysia, environment isolation and governance tests
without combining the three packages into a runtime dependency.

The smallest application can contain only a controller:

```ts
import { Controller, Get } from "@supacloud/app";

@Controller("/health")
export class HealthController {
  @Get("/ping")
  ping() {
    return { ok: true };
  }
}
```

Run `bunx supacloud-compiler compile` from the project root. The compiler
discovers the controller under `src/`, writes artifacts to `generated/`, and
enables strict checks by default. A module, provider, database client, or
command governance configuration is only needed when the application uses
that capability.

`defineFeatureSpec` preserves literal state/event types and rejects transition
endpoints outside `states` at type-check time. `FeatureState<typeof spec>` and
`FeatureEvent<typeof spec>` expose those unions to application code. Runtime
assertions and authoritative database checks are still required for external input.

Runtime DI delegates to Angular's public `@angular/core` APIs through a small
compatibility adapter. SupaCloud decorators retain module/compiler metadata,
while production application factories remain compiler-generated and
reflection-free.

## Runtime Boundary

Angular is the runtime DI engine: `InjectionToken`, hierarchical injectors,
`inject()`, `DestroyRef`, provider caching and lifecycle execution are delegated
to Angular public APIs. SupaCloud does not reimplement those mechanisms.

SupaCloud still owns the application model that Angular does not define:
`Module`, `Scope`, provider descriptors, controllers, commands, jobs, route
metadata, static aspects, `ApplicationGraph` and compiler diagnostics. Use
SupaCloud decorators for these semantics; they are compiler input, not Angular
decorator aliases.

## Static AOP

Use one `around(context, next)` function for cross-cutting behavior at the
module, route, command, or job boundary:

```ts
import type { Aspect } from "@supacloud/app";

const auditAspect: Aspect = async (context, next) => {
  const result = await next();
  await audit.write(context, result);
  return result;
};

@Module({ name: "case", aspects: [auditAspect] })
export class CaseModule {}
```

Aspect references must be explicit function identifiers. The compiler rejects
variables, spread expressions, strings, dynamic pointcuts, Proxy, and runtime
aspect registration. Angular remains the DI runtime; aspects are SupaCloud
compiler metadata and generated execution order.

```ts
import {
  Command,
  Controller,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Post,
} from "@supacloud/app";

export const CASE_REPOSITORY = new InjectionToken<CaseRepository>("case.repository");

@Injectable()
export class CaseService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly repository: CaseRepository,
  ) {}
}

@Command({ name: "case.accept", permission: "case.accept", transaction: "required" })
export class AcceptCaseCommand {
  constructor(private readonly cases: CaseService) {}
}

@Controller("/cases")
export class CaseController {
  constructor(private readonly acceptCase: AcceptCaseCommand) {}

  @Post("/:caseId/accept", { body: CaseAcceptInput })
  accept() {
    return this.acceptCase.execute();
  }
}

@Module({
  name: "case",
  providers: [
    CaseService,
    { provide: CASE_REPOSITORY, useClass: DrizzleCaseRepository },
    AcceptCaseCommand,
  ],
  controllers: [CaseController],
  exports: [CaseService],
})
export class CaseModule {}
```

## Scopes

| Scope | Lifetime | May depend on |
|---|---|---|
| `application` (default) | whole function instance | `application` only |
| `request` | one HTTP request | `application`, `request` |
| `job` | one background task | `application`, `job` |

The compiler rejects scope violations (e.g. an `application` provider
depending on a `request` provider) at build time.

## Built-in Tokens

- `DB_CLIENT` — Platform database / Drizzle client (`application` scope).
- `REQUEST_CONTEXT` — HTTP request context (`request` scope).
- `JOB_CONTEXT` — Background job execution context (`job` scope).

## Non-decorator usage

`defineModule(options)` produces the same metadata as `@Module(options)` and
can be used where decorators are not enabled.

## Feature Slices and State Machines

`defineFeatureSlice` is an explicit, colocated feature slice entrypoint. It compiles
into a standard `ApplicationGraph` module without bypassing provider, route, command,
or module-boundary governance rules:

```ts
import { defineFeatureSlice, defineFeatureSpec } from "@supacloud/app";

export const caseSpec = defineFeatureSpec({
  name: "case",
  states: ["draft", "accepted", "rejected"],
  transitions: {
    accept: {
      from: "draft",
      to: "accepted",
      permission: "case.accept",
      command: "AcceptCaseCommand",
    },
  },
});

export const CaseFeature = defineFeatureSlice({
  name: "case",
  tags: ["type:feature", "scope:case"],
  spec: caseSpec,
  providers: [AcceptCaseCommand],
  controllers: [CaseController],
});
```

The compiler validates that feature states, commands, permissions, and transactions
remain synchronized and detects architectural drift at build time.
