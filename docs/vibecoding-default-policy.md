# Vibecoding Default Policy

## Principle

A default is not the smallest feature set. It is the option currently judged
best for usability, maturity, verification and long-term maintenance.

When there is no special requirement:

1. provide one recommended path;
2. make generators, documentation and AI context use that path;
3. require explicit selection for alternatives;
4. prevent alternatives from creating a second source of truth or governance model.

The goal is to reduce architectural entropy, not to remove advanced capabilities.

## Default Selection

| Problem | Default | Explicit exception |
| --- | --- | --- |
| One-shot async business | `Promise<T>` + `async/await` | A stream type for continuous work or an ecosystem boundary |
| Continuous event protocol | `AsyncIterable<TEvent>` | RxJS/Angular integration where that boundary is the better fit |
| Reactive library | RxJS, the existing project-wide library | No second Observable/stream library without a recorded requirement |
| HTTP byte stream | Native `Response` / `ReadableStream<Uint8Array>` | Convert only at an explicit ecosystem boundary |
| Database structure | Drizzle schema + append-only migration | No second ORM or hand-maintained structure source |
| Database governance | `defineDatabaseModule`, SQL lint and Catalog reconciliation | Disabling governance is a recorded migration exception |
| Ordinary reads | PostgREST / `supabase-js` | GraphQL for an explicit Query Contract |
| Cross-table writes | Command / RPC with permission, transaction, idempotency and audit | Controlled CRUD for simple single-table operations |
| Durable execution | Workflow/Command | pgflow or pg_durable after a proven scenario |
| New application template | `minimal` | Explicit `command`, `http` or `edge` recipe |
| Local development | `fast`, without an external database | `integration` with an explicit loopback URL |
| Generated output | Compiler-generated and drift-checked | Never hand-edit generated directories to bypass checks |
| Failure handling | Fail closed and preserve the last valid output | No implicit repair, migration or silent downgrade |
| Write retry | No automatic retry by default | Explicitly enabled only with a server idempotency contract |
| External side effects | Receipt plus reconciliation | Unknown outcomes must not be redispatched automatically |
| AI context | Read-only structured context pack | No credentials, real data or arbitrary repository scan |

## Adding An Alternative

An alternative is admitted only when all of these are true:

- the default cannot express the real requirement;
- ownership, lifecycle, cancellation, error and retry semantics are explicit;
- type, governance and negative tests exist;
- it does not duplicate submission or create a second source of truth;
- the compiler or explicit configuration can identify its use.

Familiarity, similar APIs or a possible future need are not sufficient reasons.
