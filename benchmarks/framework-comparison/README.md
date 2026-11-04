# Framework comparison benchmark

This benchmark compares the same small HTTP contract across SupaCloud and
native mainstream framework installations:

- SupaCloud's compiled application adapter on Elysia 2/Bun;
- Express on Node;
- Fastify on Node;
- NestJS on Express;
- NestJS on the native Node adapter (`@nestjs/platform-node`);
- Gin on Go 1.27.

It also records native Elysia 2/Bun with the same TypeBox contracts. Every adapter in the comparison validates the
same request contract; an unvalidated bare transport baseline is excluded.

The server contract is deliberately small so the result isolates routing,
JSON serialization, path parameter matching and JSON body parsing. Every
adapter runs in its own child process. A single Node `fetch` client drives all
adapters over loopback with the same warmup, concurrency, request count and
rotated scenario order. SupaCloud uses the release-tagged local
`@supacloud/elysia` package. Before each run, `generate.mjs` uses that checkout's
compiler to emit real route invokers from the benchmark controller graph. The contract baseline validates params and
body with equivalent schemas: Elysia/SupaCloud use native route schemas,
Fastify uses JSON Schema/Ajv, Express/Nest use TypeBox middleware/pipes, and
Gin uses Go binding validator tags.
Before timing, every adapter must accept zero and empty strings and reject missing,
null, malformed and incorrectly typed body fields. Fastify coercion is disabled
to match the other validators. Gin uses pointer fields to distinguish zero from
missing values. All measured scenarios validate response values in the client;
server-side response schemas are not part of this baseline.

Run locally after installing Bun, Node 24 and Go 1.27:

```sh
for package in contracts delivery commands db compiler app elysia; do
  (cd "packages/$package" && bun install --frozen-lockfile && bun run build)
done
cd benchmarks/framework-comparison
bun install --frozen-lockfile
node runner.mjs --requests 10000 --rounds 5 --concurrency 32 --output report.json
```

The runner builds Gin once before starting measurements and removes the temporary
binary after the run. Runtime versions come from the running processes. SupaCloud
and native Elysia both use `Bun.serve({ fetch: app.fetch })`.

The benchmark uses compiler-generated route execution plans: direct routes call
the Elysia-decoded context without a SupaCloud input envelope, while complex
routes use the positional SupaCloud invoker. It provides an `x-request-id`
header, matching the Edge Runtime request boundary.

Use `--request-id-mode generated` to omit the supplied request ID. These direct
routes need no SupaCloud request context, so this does not itself exercise UUID
generation; use a context-dependent business fixture for that measurement.
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
