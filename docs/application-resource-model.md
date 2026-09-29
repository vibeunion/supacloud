# Application Resource Model

Status: **IMPLEMENTED (static slice)**. The compiler declares, validates and
serializes logical infrastructure resources and their uses. Runtime credential
resolution and per-environment binding are **not** implemented here; see
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
| `EnvironmentBinding` | Where a logical resource is bound per environment | *(future work; not in this slice)* |

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
  uses: [{ resource: AttachmentsBucket, operations: ["publish"] }],
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

`operations` is one or more of `read | write | publish | consume`; when omitted
it defaults to `read`. A command or job may only use resources its module
declared.

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
| SC8105 | `invalid-resource-operation` | An operation is not `read \| write \| publish \| consume` |

Run the documented reproduction for each code in [docs/errors](./errors/README.md).

## Boundaries

- **Declaration vs physical infrastructure.** The application declares "needs
  an `attachments` bucket"; the platform decides which project storage binding
  it maps to. This slice does not add bucket-level multi-backend or failover.
- **Static declaration vs runtime evidence.** The compiler checks declarations,
  references and the allowed operation vocabulary. It does **not** prove that a
  target environment provides the resource, the right permissions or a working
  transaction. Deployment preflight and runtime evidence remain separate.
- **Explicit references only.** Only explicit `@InfraResource` classes referenced
  from `resources`/`uses` are analyzed. Dynamic SQL, arbitrary `fetch` and
  third-party SDKs are not inferred; treat them as explicit external dependencies.
- **Fail closed before startup.** Missing, unknown or undeclared resources are
  compile-time errors, not first-request failures.

## Code generation

This slice is analysis-only. Generated `application.ts` does not change, and the
model does not inject credentials or construct resource clients. Runtime binding
is intentionally deferred so it can be designed together with the local dev entry
and full-application preview.

## Next steps

1. `EnvironmentBinding` config and a runtime resolver (local/integration/profile).
2. Deployment preflight that checks the actual binding, permissions and health.
3. Local `app dev` consuming the graph to connect declared resources.
4. Delivery/receipt evidence referencing the bound resource version.