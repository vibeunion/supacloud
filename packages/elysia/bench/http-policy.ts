import { Elysia, t } from "elysia";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { cpus } from "node:os";
import elysiaPackage from "elysia/package.json";
import {
  createApplication, createHttpPolicySuite, createHttpTelemetry,
  createMemoryHttpCacheStore, createMemoryHttpRateLimitStore, type CompiledModule, type SupAuthContextOptions,
} from "../src/index";

const count = Number(process.env.BENCH_REQUESTS ?? 3000);
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 16);
for (const value of [count, rounds, concurrency]) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Benchmark sizes must be positive integers");
}
const params = t.Object({ tenant: t.String() });
function compiled(policies?: unknown[], onHandle?: () => void): CompiledModule {
  return {
    name: "bench", createServices: () => ({ controller: { run: () => { onHandle?.(); return { value: 42 }; } } }),
    controllers: [{
      path: "", serviceKey: "controller", scope: "application",
      routes: [{ method: "GET", path: "/:tenant", handler: "run", params, data: { httpPolicies: policies } }],
    }],
  };
}
const keys = await generateKeyPair("ES256");
const token = await new SignJWT({
  sub: "bench", role: "authenticated", client_id: "bench",
}).setProtectedHeader({ alg: "ES256", kid: "bench" })
  .setIssuer("https://identity.example").setAudience("bench").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
const auth: SupAuthContextOptions = {
    issuer: "https://identity.example", audience: "bench", clientId: "bench", projectId: "bench",
    jwksUrl: "https://identity.example/keys",
    keyResolver: createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), alg: "ES256", kid: "bench" }] }),
    resolveAccess: async () => ({ projectId: "bench", tenantId: "tenant", permissions: ["read"] }),
};
interface Scenario {
  name: string;
  app: { handle(request: Request): Response | Promise<Response> };
  cache?: { mode: "hit" | "miss"; stats: { handlers: number; hits: number; fills: number } };
}
function policyScenario(mode: "hit" | "miss"): Scenario {
  const store = createMemoryHttpCacheStore();
  const stats = { handlers: 0, hits: 0, fills: 0 };
  const suite = createHttpPolicySuite({
    auth, cacheNamespace: "bench-v1", rateLimitStore: createMemoryHttpRateLimitStore(),
    cacheStore: {
      generation: () => store.generation(),
      get: async (key, generation) => {
        const entry = await store.get(key, generation);
        if (entry) stats.hits++;
        return entry;
      },
      set: async (key, entry, generation) => { await store.set(key, entry, generation); stats.fills++; },
      clear: () => store.clear(),
    },
  });
  return { name: `compiled-security-cache-${mode}-trace`, cache: { mode, stats }, app: createApplication({
    ...suite, http: createHttpTelemetry(() => {}),
    modules: [compiled([
      { name: "authenticated" }, { name: "tenant", options: { param: "tenant" } },
      { name: "permission", options: { allOf: ["read"] } },
      { name: "rateLimit", options: { limit: 1_000_000_000, windowMs: 3600000 } },
      { name: "cache", options: { ttlMs: 3600000 } },
    ], () => { stats.handlers++; })],
  }) };
}
const scenarios: Scenario[] = [
  { name: "native-static", app: new Elysia().get("/:tenant", () => ({ value: 42 }), { params }) },
  { name: "compiled-static", app: createApplication({ modules: [compiled()] }) },
  { name: "compiled-one-noop-policy", app: createApplication({
    modules: [compiled([{ name: "noop" }])], httpPolicies: { noop: () => () => {} },
  }) },
  policyScenario("hit"), policyScenario("miss"),
];

async function batch(url: URL, requests: number, uniquePrefix?: string) {
  const latency = new Float64Array(requests);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < requests) {
      const index = next++;
      const started = performance.now();
      const target = uniquePrefix === undefined ? url : new URL(`?sample=${uniquePrefix}-${index}`, url);
      const response = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (response.status !== 200 || body.value !== 42) throw new Error("Benchmark response contract failed");
      latency[index] = performance.now() - started;
    }
  }));
  return latency;
}

const samples: Record<string, unknown>[] = [];
for (let round = 0; round < rounds; round++) {
  // Rotate order to reduce warmup/order bias; each scenario gets its own listener.
  for (let offset = 0; offset < scenarios.length; offset++) {
    const scenario = scenarios[(round + offset) % scenarios.length]!;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => scenario.app.handle(request) });
    try {
      const url = new URL("/tenant", server.url);
      await batch(url, Math.min(count, 500), scenario.cache?.mode === "miss" ? `warm-${round}` : undefined);
      await Bun.sleep(50);
      Bun.gc(true);
      const before = process.memoryUsage();
      const counters = scenario.cache ? { ...scenario.cache.stats } : undefined;
      const start = performance.now();
      const latency = await batch(url, count, scenario.cache?.mode === "miss" ? `measured-${round}` : undefined);
      const elapsedMs = performance.now() - start;
      const after = process.memoryUsage();
      latency.sort();
      await Bun.sleep(50);
      Bun.gc(true);
      const retained = process.memoryUsage();
      const measured = scenario.cache && counters ? {
        handlers: scenario.cache.stats.handlers - counters.handlers,
        hits: scenario.cache.stats.hits - counters.hits,
        fills: scenario.cache.stats.fills - counters.fills,
      } : undefined;
      if (scenario.cache && measured) {
        const hit = scenario.cache.mode === "hit";
        if (measured.handlers !== (hit ? 0 : count) || measured.hits !== (hit ? count : 0)
          || measured.fills !== (hit ? 0 : count)) throw new Error("Benchmark cache path assertion failed");
      }
      samples.push({
        scenario: scenario.name, round, requests: count, concurrency,
        requestsPerSecond: count / elapsedMs * 1000,
        p50Ms: latency[Math.floor((count - 1) * 0.5)],
        p95Ms: latency[Math.floor((count - 1) * 0.95)],
        p99Ms: latency[Math.floor((count - 1) * 0.99)],
        heapGrowthBytes: after.heapUsed - before.heapUsed,
        retainedHeapDeltaBytes: retained.heapUsed - before.heapUsed,
        rssBytes: after.rss,
        ...(measured ? { cacheCounters: measured } : {}),
      });
    } finally { await server.stop(true); }
  }
}
const report = {
  date: new Date().toISOString(), bun: Bun.version, elysia: elysiaPackage.version,
  platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  methodology: "Single-process loopback HTTP including fetch client, warmup, rotated scenarios and response assertions. Sorting is outside throughput timing. Separate asserted cache-hit/miss paths use real local ES256 verification and a fixed in-process membership resolver. Heap deltas are GC-sensitive live-memory metrics, NOT total allocated bytes. No remote DB, JWKS, authorization service or production load.",
  samples,
};
const output = process.argv[2];
if (output) await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
else console.log(JSON.stringify(report, null, 2));
