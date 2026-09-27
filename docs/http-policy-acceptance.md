# HTTP Policy Follow-Up Acceptance

Date: 2026-09-25
Status: PASS for the scoped implementation and local acceptance below.
Parent: declarative HTTP policy extension implementation.
Source: user request "全部完成".
Reason: complete the previously reported PARTIAL capability and acceptance gaps.

## Contract

- Goal: reusable authentication, tenant/permission checks, rate limiting, private
  JSON caching, request tracing, integrated tests, measured performance and local
  PostgreSQL/full Elysia acceptance.
- Non-goals: runtime DI container, replacing command governance, production writes,
  deployment, commits or publishing; vendor-specific telemetry hosting.
- Orchestration: panel, one writer and two read-only reviewers. Security-sensitive
  policy/cache boundaries trigger review. Existing unrelated work is preserved.
- Risk: high, due to authorization, tenant isolation and shared-cache boundaries.
- Acceptance: native lifecycle tests, forged/revoked credentials, tenant/user
  separation, denied/failed operations, cache safety, bounded stores, compiler
  metadata preservation, type/build checks, benchmark report and full adapter suite.

## Implemented

- Original compile-time service construction remains unchanged.
- `createHttpPolicySuite`: verified SupAuth identities, current application access,
  authenticated routes, tenant parameter checks and exact permission requirements.
- Route quotas and private JSON response caching, with bounded local stores and
  real PostgreSQL shared stores.
- Cache release namespaces, generation-based invalidation, atomic stale-fill
  rejection, single-serialization response snapshots and conservative exclusions.
- Global request telemetry including invalid, denied, failed and unmatched routes;
  correlation IDs are shared with request/command contexts.
- Existing command transactions, durable audit, idempotency and recovery remain
  authoritative. HTTP policies do not replace them.

## Review Closures

Two independent read-only reviewers examined security and concurrency/performance.
The following findings were fixed and covered by regressions:

- Old representations crossing rolling releases: explicit cache namespace.
- Re-running `toJSON` after response delivery: snapshot actual native response bytes.
- Identity-provider public errors leaking details: sanitize dependency failures to 503.
- Quota requests crossing expiry during lock waits: observe time after row locking.
- Old in-flight cache fills after invalidation: atomically check shared generation.
- Concurrent quota expiry pruning: retry only a missing row before lock acquisition.
- Ambiguous concurrency evidence: verify the blocked backend PID before epoch change.
- Benchmark sorting overhead and unverified cache paths: exclude sorting from timing,
  split hit/miss cases and assert handler/hit/fill counters.

## Verification Environment

- Bun 1.4.2; Elysia 1.4.30; local macOS arm64.
- Dedicated PostgreSQL 18.4 cluster under a temporary directory, listening only
  on loopback. Database: `supacloud_commands_test`.
- Real upstream PGMQ 1.10.0, installed into an isolated extension directory using
  PostgreSQL 18 `extension_control_path`; not a Lite queue substitute.
- `scripts/prepare-command-test-database.ts` installed the existing Workflow and
  Command runtime in that isolated database.
- No production databases, remote accounts, commits, pushes or deployments.

## Original Workspace Evidence

Final frozen-source verification in the original development workspace:

- Elysia full suite: **275 passed, 0 failed, 0 skipped**, 32 files, 1116 assertions,
  499.53 seconds. Real PostgreSQL/PGMQ runtime tests were enabled.
- Compiler generation, scoped dependencies and migrations: **50 passed, 0 failed**.
- Elysia source/test type checks and compiler/Elysia JS/declaration builds passed.
- Built Elysia package policy exports and cache API smoke passed.
- Workspace architectural boundary check passed for 22 packages.
- Public API checks passed: app 301 exports, compiler 169 exports.
- Final diff checks and both reviewers' bounded follow-up checks passed.
- Temporary PostgreSQL server shut down after verification.
- clean-code-guard: clean.

Earlier development runs exposed timing, lifecycle and concurrency issues; the
numbers above refer to the final implementation, not a mix of those earlier runs.

The compiler checks use:

```sh
bun test src/migrations.test.ts src/generate.test.ts src/scoped-external-deps.test.ts --timeout 180000
```

The Elysia checks use a dedicated local database:

```sh
SUPACLOUD_COMMAND_TEST_URL="$ISOLATED_TEST_URL" \
SUPACLOUD_REQUIRE_RUNTIME_SAFETY=1 \
SUPACLOUD_TEST_TIMINGS=1 bun test --timeout 180000
bun run typecheck:test
bun run build
```

The contract-upgrade test retains migration preview/write/idempotence, generated
artifact execution, both TypeScript API and CLI positive/negative assertions,
HTTP responses and checkpoint restoration. Its old 30-second deadline could not
cover the real dependency graph: a diagnostic Program loaded 794 source files
and took about 48 seconds on this machine. The test now has a bounded 600-second
budget, matching CLI/API ambient types and independently terminated/awaited CLI
children. The migration no longer re-analyzes unchanged files with a context-free
Program.

## Performance Boundaries

The benchmark uses real loopback HTTP with the fetch client in the same process.
It checks native static routes, compiled static DI, a no-op policy and the complete
verified policy pipeline with distinct asserted cache-hit and cache-miss paths.
Local ES256 verification is real; membership resolution is a fixed in-process
fixture. Remote JWKS, database and membership-service latency are not simulated.

P50/P95/P99 and throughput include client transport/body handling; sorting is
outside the timed region. Live heap deltas, post-GC retained heap and RSS are
reported, not mislabeled as cumulative JavaScript allocation counts. These local
results are not a production capacity SLA or evidence about Hono performance.

## Measured Results

Raw report: [http-policy-benchmark.json](./http-policy-benchmark.json).

Apple M4, macOS arm64, Bun 1.4.2, Elysia 1.4.30. Five rotated rounds per scenario,
20,000 measured requests per round, concurrency 16, plus warmup. Total measured
requests: **500,000**. This run was performed after the full test/build workloads
finished. Values below are medians of each round's measurements, not pooled
percentiles:

| Scenario | Requests/sec | P95 ms | P99 ms | Post-GC heap delta bytes |
| --- | ---: | ---: | ---: | ---: |
| Native static Elysia | 123,889 | 0.265 | 0.496 | -80 |
| Compiled static DI adapter | 76,895 | 0.463 | 0.777 | -20,324 |
| Compiled adapter plus one no-op policy | 78,536 | 0.452 | 0.718 | -16,416 |
| Verified security, cache hit, tracing | 28,325 | 1.180 | 1.635 | 58,269 |
| Verified security, cache miss/fill, tracing | 17,763 | 1.744 | 2.173 | 202,292 |

Each hit round asserted exactly 20,000 hits, zero handler calls and zero fills.
Each miss round asserted zero hits, exactly 20,000 handler calls and 20,000 fills.
Heap measurements include the same-process client and benchmark harness; negative
deltas are possible after GC. RSS and every individual sample remain in the report.

The small no-op-vs-static difference is measurement variation, not evidence that
adding a policy improves performance or costs nothing. Native-static has fewer
responsibilities than the adapter; full security includes cryptographic and
storage work. No isolated DI overhead percentage or production throughput
guarantee is inferred from these results.

## Merge Follow-Up

Parent: the scoped implementation and local acceptance above.
Source: user request "全部完成后合并到 main".
Reason: authorize a scoped commit, pull request and merge after candidate validation.

The merge candidate is based on `origin/main` at `456efcd8`, in an isolated
worktree. Other pending delivery, CLI, management API and borrowed-resource
changes are excluded. Third-party dependencies are reused locally, but all
SupaCloud dependencies are rebuilt from candidate sources. The original
workspace evidence and benchmark above are historical, not a certification
of the extracted candidate. Production deployment remains out of scope.

Candidate verification:

- Elysia full suite: **274 passed, 0 failed, 0 skipped**, 31 files,
  1112 assertions, 435.98 seconds, with real PostgreSQL 18.4 and PGMQ 1.10.0.
  The unrelated borrowed-resource test is not part of this candidate.
- Compiler generation and migrations: **49 passed, 0 failed**, 236 assertions.
- Contracts, app, commands, database, compiler and Elysia JS/declaration builds
  passed from candidate sources; Elysia test type checking passed.
- Workspace boundaries passed for 21 packages. Public API checks passed:
  app 301 exports, compiler 162 exports.
- Both independent reviewers found no extraction omissions or blocking changes.
- The initial database run used the wrong local server port and failed to connect.
  After explicitly starting the isolated server on port 55439, the complete
  Elysia suite passed as recorded above; the server was then stopped.
- Additional compiler-wide testing returned 416 passes and two GraphQL consumer
  timeouts at their existing 20-second deadlines. Isolated source-CLI reruns
  also timed out. The GraphQL CLI, generation and test files are unchanged
  from the base. This is not recorded as a full compiler-suite pass; required
  clean CI must pass before merge.
