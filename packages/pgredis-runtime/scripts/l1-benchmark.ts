/**
 * Self-contained L1 benchmark for the pgredis data plane.
 *
 * It drives the upstream `PgKvCache` against a simulated L2 that records every
 * query, so the effect of L1, read coalescing (singleflight), the negative
 * cache, and the byte budget can be measured without a live PostgreSQL.
 *
 * Run with `bun run benchmark:l1`.
 */
import { PgKvCache, type BunSqlLike } from "@postgresx/noredis";

interface BenchResult {
  scenario: string;
  queries: number;
  l1Hits: number;
  negativeHits: number;
  coalesced: number;
  bytes: number;
  l1Size: number;
  durationMs: number;
}

class SimulatedL2 implements BunSqlLike {
  readonly store = new Map<string, unknown>();
  queries = 0;
  delayMs = 0;

  private compound(namespace: string, key: string): string {
    return `${namespace}\u0000${key}`;
  }

  async unsafe<T = Record<string, unknown>>(
    query: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const normalized = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("SELECT VALUE")) {
      this.queries += 1;
      if (this.delayMs > 0) await Bun.sleep(this.delayMs);
      const value = this.store.get(this.compound(String(params[0]), String(params[1])));
      return (value === undefined ? [] : [{ value, expires_at: null }]) as T[];
    }
    if (normalized.startsWith("SELECT PG_NOTIFY")) return [] as T[];
    if (normalized.startsWith("INSERT INTO")) {
      const namespace = String(params[0]);
      const key = String(params[1]);
      this.store.set(this.compound(namespace, key), JSON.parse(String(params[2])) as unknown);
      return [{ key }] as T[];
    }
    return [] as T[];
  }
}

function report(result: BenchResult): void {
  const hitRatio =
    result.l1Hits + result.queries > 0 ? result.l1Hits / (result.l1Hits + result.queries) : 0;
  console.log(
    [
      result.scenario.padEnd(34),
      `queries=${String(result.queries).padStart(6)}`,
      `hit=${String(result.l1Hits).padStart(6)}`,
      `neg=${String(result.negativeHits).padStart(5)}`,
      `coalesced=${String(result.coalesced).padStart(5)}`,
      `size=${String(result.l1Size).padStart(5)}`,
      `bytes=${String(result.bytes).padStart(7)}`,
      `ratio=${hitRatio.toFixed(3)}`,
      `ms=${result.durationMs.toFixed(1)}`,
    ].join("  "),
  );
}

function summarize(
  scenario: string,
  sql: SimulatedL2,
  cache: PgKvCache,
  startedAt: number,
): BenchResult {
  const stats = cache.stats();
  return {
    scenario,
    queries: sql.queries,
    l1Hits: stats.l1Hits,
    negativeHits: stats.l1NegativeHits,
    coalesced: stats.coalescedReads,
    bytes: stats.l1Bytes,
    l1Size: stats.l1Size,
    durationMs: performance.now() - startedAt,
  };
}

async function hotReads(): Promise<BenchResult> {
  const sql = new SimulatedL2();
  const cache = new PgKvCache({ sql, namespace: "bench", l1: { max: 1_000, ttlMs: 60_000 } });
  for (let index = 0; index < 100; index += 1) {
    await cache.set(`key:${index}`, { value: index });
  }
  const startedAt = performance.now();
  for (let index = 0; index < 100_000; index += 1) {
    await cache.get(`key:${index % 100}`);
  }
  return summarize("hot reads (100 keys x1000)", sql, cache, startedAt);
}

async function stampede(singleflight: boolean): Promise<BenchResult> {
  const sql = new SimulatedL2();
  sql.delayMs = 2;
  const cache = new PgKvCache({
    sql,
    namespace: "bench",
    singleflight,
    l1: { max: 1_000, ttlMs: 60_000 },
  });
  for (let index = 0; index < 20; index += 1) {
    await cache.set(`key:${index}`, { value: index });
  }
  for (let index = 0; index < 20; index += 1) cache.invalidate(`key:${index}`);
  const before = sql.queries;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, (_row, index) =>
      Promise.all(Array.from({ length: 50 }, () => cache.get(`key:${index}`))),
    ),
  );
  const result = summarize(
    `stampede singleflight=${singleflight} (20x50)`,
    sql,
    cache,
    startedAt,
  );
  result.queries -= before;
  return result;
}

async function negativeCache(negativeTtlMs: number): Promise<BenchResult> {
  const sql = new SimulatedL2();
  sql.delayMs = 1;
  const cache = new PgKvCache({ sql, namespace: "bench", l1: { negativeTtlMs } });
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    await cache.get(`absent:${index % 50}`);
  }
  return summarize(`absent reads negativeTtlMs=${negativeTtlMs}`, sql, cache, startedAt);
}

async function byteBudget(): Promise<BenchResult> {
  const sql = new SimulatedL2();
  const chunk = "x".repeat(1_024);
  const cache = new PgKvCache({
    sql,
    namespace: "bench",
    l1: { max: 100_000, maxBytes: 65_536, ttlMs: 60_000 },
  });
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    await cache.set(`key:${index}`, { payload: chunk });
  }
  return summarize("byte budget maxBytes=64KiB", sql, cache, startedAt);
}

console.log("pgredis L1 benchmark (simulated L2)");
console.log("scenario                            queries   hit     neg coalesced   size    bytes   ratio     ms");
report(await hotReads());
report(await stampede(true));
report(await stampede(false));
report(await negativeCache(0));
report(await negativeCache(250));
report(await byteBudget());