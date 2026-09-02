# @supacloud/app

Angular-style application metadata for SupaCloud applications: modules, DI
tokens, providers, scopes, controllers and commands.

This package is **metadata only**. Decorators attach metadata to classes; the
SupaCloud compiler (`@supacloud/compiler`) reads that metadata from source,
validates the dependency graph and generates plain static factories — there is
no runtime reflection and no `reflect-metadata` dependency.

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
