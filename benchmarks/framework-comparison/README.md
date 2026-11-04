# Framework comparison benchmark

This benchmark compares the same small HTTP contract across SupaCloud and
native mainstream framework installations:

- SupaCloud's compiled application adapter on Elysia 2/Bun;
- Express on Node;
- Fastify on Node;
- NestJS on Express;
- NestJS on the native Node adapter (`@nestjs/platform-node`).

It also records native Elysia 2/Bun twice: once with the same TypeBox contracts
and once as a bare transport floor. The headline comparison is SupaCloud versus
the four native Node framework paths; native Elysia is not presented as a
competing product.

The server contract is deliberately small so the result isolates routing,
JSON serialization, path parameter matching and JSON body parsing. Every
adapter runs in its own child process. A single Node `fetch` client drives all
adapters over loopback with the same warmup, concurrency, request count and
rotated scenario order. SupaCloud uses the release-tagged local
`@supacloud/elysia` package, so its compiler/runtime path is measured rather
than a hand-written Elysia route. The contract baseline validates params and
body with the same TypeBox schemas: Elysia/SupaCloud use native route schemas,
Fastify uses JSON Schema/Ajv, and Express/Nest use TypeBox middleware/pipes.
No framework is allowed to skip validation in the contract comparison.

Run locally after installing Bun and Node 24:

```sh
for package in contracts delivery commands db compiler app elysia; do
  (cd "packages/$package" && bun install --frozen-lockfile && bun run build)
done
cd benchmarks/framework-comparison
bun install --frozen-lockfile
node runner.mjs --requests 10000 --rounds 5 --concurrency 32 --output report.json
```

The benchmark uses the compiler-generated positional route invoker and provides
an `x-request-id` header, matching the Edge Runtime request boundary.

Use `--request-id-mode generated` to measure the fallback UUID path separately.
Use `--only supacloud-elysia-bun,elysia-native-contract-bun` for a focused
ablation or profiler run.

The command writes `report.json` and `report.md`. The defaults are intended for
CI. Use a smaller request count for a quick smoke test; do not compare smoke
test numbers with the normal CI report.

The report is a relative framework-overhead signal, not a production capacity
claim. It excludes database, TLS, network, authentication, logging and real
application work. Keep the runtime versions, runner image and benchmark
configuration fixed when comparing releases. Treat a change as meaningful only
after repeated runs on the same runner show a stable direction; the workflow
does not fail on a single noisy regression.
