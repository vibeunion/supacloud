# Semantic codebase identity

SupaCloud now exposes a read-only semantic projection of the compiler graph. It is inspired by Blood's idea of giving tools a stable view of program structure, while keeping SupaCloud's existing compiler, database governance, Command transaction and delivery manifests as the authorities.

The projection keeps two identities side by side:

- `sourceHash` is a digest of the raw project inventory. It answers whether source inputs changed.
- `semanticHash` is a digest of normalized module, provider, route, Command, Job, query, permission, Effect, contract and migration nodes. It ignores source locations, object key order and declaration order where the compiler treats the collection as unordered.

Use the lens locally:

```sh
supacloud app lens --root . --format json
supacloud app lens --root . --target OrdersModule --format json
```

The compiler CLI provides the same read-only view and a file-based comparison for CI or an agent:

```sh
supacloud-compiler lens . --json > current.semantic.json
supacloud-compiler semantic-diff base.semantic.json current.semantic.json --json
```

The diff classifies additions, removals and changes by semantic category. Permission, transaction, idempotency, Effect, route contract and migration fingerprint changes are surfaced separately. A migration fingerprint change is an error because applied migration bytes are append-only. A route or Command change marks generated artifacts for regeneration; it does not write or apply them.

`app context` includes a compact semantic summary, and generated `app.manifest.json` includes the semantic hash and node count under `executionPlan.semantic`. The projection is intentionally read-only: it cannot authorize requests, execute migrations, replace RLS, or become a second runtime schema.
