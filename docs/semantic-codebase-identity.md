# Semantic codebase identity

SupaCloud exposes a read-only semantic projection of the compiler graph. It gives tools a stable view of program structure while keeping the existing compiler, database governance, Command transaction and delivery manifests as the authorities.

The projection keeps two identities side by side:

- `sourceHash` is a digest of the raw project inventory (tracked `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.json` inputs). It answers whether source inputs changed, including files that do not appear in the graph.
- `semanticHash` is a digest of normalized module, provider, route, Command, Job, query, permission, Effect, contract and migration nodes. It ignores source locations and object key order, and it normalizes collections the compiler treats as unordered: imports/exports, module tags and resources, provider deps, route tags/guards/resolvers keys, Command `uses`/`branches`, Job `uses`, Effect dependencies and error mappings, and GraphQL documents/operations. Declaration order inside those collections is not semantic and does not change the hash.

`semanticHash` is a structural identity, not a proof of behavioural equivalence: array order the compiler does treat as meaningful (for example parameter order or route response precedence) still changes the hash.

Use the lens locally:

```sh
supacloud app lens --root . --format json
supacloud app lens --root . --target OrdersModule --format json
supacloud app lens --root . --target OrdersModule --format json --detail
```

The compiler CLI provides the same read-only view and a file-based comparison for CI or an agent:

```sh
supacloud-compiler lens . --json > current.semantic.json
supacloud-compiler lens . --json --detail > current.semantic.detail.json
supacloud-compiler semantic-diff base.semantic.json current.semantic.json --json
```

Lens output is compact by default: nodes carry `id`, `kind`, `hash` and `dependencies`, and the snapshot keeps `sourceHashes` (digests only) so it can be persisted and compared. `--detail` adds the per-node `value` payload that explains a hash change and lets `semantic-diff` re-diagnose governance conflicts offline. Degraded, value-free snapshots still compare hashes and migration fingerprints. `semantic-diff` accepts either a persisted `lens` document or a bare snapshot.

The diff classifies additions, removals and changes by semantic category. A migration fingerprint change is an error because applied migration bytes are append-only, and migration node identity follows the ledger entry (`executor/version/name/path`), not its position in the input. A route or Command change marks generated artifacts for regeneration (`requiresRegeneration`); the lens does not write, generate or apply them.

Governance conflicts are not re-implemented here. Route ownership and Command permission mismatches are projected from the graph, and Effect rules are delegated to the compiler's own `validateEffectPolicies`. The lens evaluates the unconditional policy rules and leaves project-configured strictness (required mappings, dependencies, retry policy, timeouts, tagged errors) to `app check`, so the lens reports a subset of compile diagnostics and can never be stricter than the compile gate. Every conflict is an error; there is no separate warning tier.

`app context` includes a compact semantic summary, and generated `app.manifest.json` includes the semantic hash and node count under `executionPlan.semantic`. The projection is intentionally read-only: it cannot authorize requests, execute migrations, replace RLS, or become a second runtime schema.