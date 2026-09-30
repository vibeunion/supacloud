# Application Resource Model

Status: **IMPLEMENTED (static slice)**. The compiler declares, validates and
serializes logical infrastructure resources and their uses. Per-environment
binding is now a separate static resolver
([Environment Bindings](./environment-bindings.md)); runtime credential
resolution is **not** implemented here; see
[Encore Alignment Roadmap](./encore-alignment-roadmap.md).

## Why

An application should declare once what infrastructure it needs — database,
bucket, queue, configuration, secret — and let the compiler, local runner,
delivery plan and inspection surfaces consume the same model. This document
covers the first slice: a compiler-readable resource model that fails before
startup when a resource is missing, unknown or used across a module that did not
declare it.

## Concepts

| Concept | Meaning | Not responsible for |
| --- | --- | --- |
| `InfraResource` | A logical resource declaration: name + kind | Holding credentials or provisioning cloud resources |
| `ResourceUse` | Which module/command/job uses a resource, and how | Inferring object-level authorization |
| `EnvironmentBinding` | Where a logical resource is bound per environment (see [Environment Bindings](./environment-bindings.md)) | Holding credentials or proving the binding is reachable |

Naming note: `@supacloud/app` already exports a reactive data-loading primitive
`resource<T>()` (`packages/app/src/resource.ts`, modeled after Angular
`resource`). The infrastructure declaration is intentionally named
`@InfraResource` to avoid confusion.

## Declaring a resource

```ts
import { InfraResource } from "@supacloud/app";

@InfraResource({ name: "orders-db", kind: "database" })
export class OrdersDatabase {}

@InfraResource({ name: "attachments", kind: "bucket" })
export class AttachmentsBucket {}
```

`kind` is one of `database | bucket | queue | config | secret`. `name` is the
stable logical name shared across environments. The declaration carries no
connection string, no credential and no hosting decision.

## Declaring uses

A module declares the resources it requires. A command or job may additionally
declare which resources it uses and which operations it performs.

```ts
import { Command, Job, Module } from "@supacloud/app";
import { AttachmentsBucket, OrdersDatabase } from "./resources";

@Command({
  name: "orders.create",
  permission: "orders.create",
  uses: [{ resource: OrdersDatabase, operations: ["read", "write"] }],
})
export class CreateOrderCommand {}

@Job({
  name: "orders.cleanup",
  uses: [{ resource: AttachmentsBucket, operations: ["write"] }],
})
export class CleanupJob {}

@Module({
  name: "orders",
  resources: [OrdersDatabase, AttachmentsBucket],
  commands: [CreateOrderCommand],
  jobs: [CleanupJob],
})
export class OrdersModule {}
```

`operations` is a nonempty static array of string literals from
`read | write | publish | consume`. **Only omitting the property** defaults to
`read`; `[]`, `null`, explicit `undefined`, scalar values, spreads and dynamic
expressions are compilation errors, never an implicit read. `resources` and
`uses` must also be static arrays; empty arrays are allowed for these two fields.
Syntax-only wrappers such as parentheses and `as const` are accepted. Unsupported
shorthand, computed or spread properties are errors when explicitly declaring
resources or uses, not silently omitted relationships.

Resource references resolve by their actual class declarations, including import
aliases, re-exports and namespace imports. Unrelated classes with the same name
cannot share or overwrite resource metadata. Repeated uses of the same resource
are merged; operations use canonical `read`, `write`, `publish`, `consume` order.

A command or job may only use resources its module declared. An automatically
registered standalone command follows the same rule for the existing `root` or
`app` module. A synthetic root grants no implicit resource declarations: declare
the resource in an explicit root/app module, or register the command in a module
that declares it. The operation vocabulary is descriptive; it does not prove
resource-kind capabilities or runtime authorization.

## Graph and manifest

`analyzeProject` produces:

```ts
interface ApplicationGraph {
  resources?: InfraResourceNode[];   // deduplicated by logical name, sorted
  resourceUses?: ResourceUseNode[];  // module/command/job -> resource + operations
  // ...
}
```

`app.manifest.json` carries the same `resources` and `resourceUses` fields, so
inspection and delivery tooling can answer:

- Which database, bucket and queue does this application require?
- Which commands and jobs use a given resource, and with which operations?
- If a resource declaration changes or is removed, which entries are affected?

## Diagnostics

| Code | Name | Meaning |
| --- | --- | --- |
| SC8101 | `duplicate-resource` | Two declarations share one logical name |
| SC8102 | `unknown-resource` | A reference is not an `@InfraResource` class |
| SC8103 | `undeclared-resource-use` | A command/job uses a resource its module did not declare |
| SC8104 | `invalid-resource-kind` | `kind` is missing or not a supported value |
| SC8105 | `invalid-resource-operation` | Operations are not a nonempty static array of supported string literals |

Per-environment binding adds SC8106-SC8108 (`missing-environment-binding`,
`unknown-environment-binding`, `invalid-environment-binding`); see
[Environment Bindings](./environment-bindings.md).

Run the documented reproduction for each code in [docs/errors](./errors/README.md).

## Boundaries

- **Declaration vs physical infrastructure.** The application declares "needs
  an `attachments` bucket"; the platform decides which project storage binding
  it maps to. This slice does not add bucket-level multi-backend or failover.
- **Static declaration vs runtime evidence.** The compiler checks declarations,
  references and the allowed operation vocabulary. It does **not** prove that a
  target environment provides the resource, the right permissions or a working
  transaction. Deployment preflight and runtime evidence remain separate.
- **Explicit declarations and references only.** All explicit `@InfraResource`
  declarations in the analyzed project are indexed, including unused declarations
  for duplicate-name diagnostics. `resources`/`uses` resolve actual declarations.
  Dynamic SQL, arbitrary `fetch` and
  third-party SDKs are not inferred; treat them as explicit external dependencies.
- **Fail closed before startup.** Missing, unknown or undeclared resources are
  compile-time errors, not first-request failures.

## Code generation

This slice is analysis-only. Generated `application.ts` does not change, and the
model does not inject credentials or construct resource clients. Runtime binding
is intentionally deferred so it can be designed together with the local dev entry
and full-application preview.

## Next steps

1. Deployment preflight that checks the actual binding, permissions and health.
2. Local `app dev` consuming the graph and
   [environment bindings](./environment-bindings.md) to connect declared
   resources in the `fast`/`integration` profiles.
3. Delivery/receipt evidence referencing the bound resource version.
