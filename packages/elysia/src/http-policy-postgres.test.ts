import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createPostgresHttpPolicyStores, HTTP_POLICY_STORE_SQL, type HttpPolicyDatabase } from "./index";

const connection = process.env.SUPACLOUD_COMMAND_TEST_URL;
const suite = connection ? describe : describe.skip;

suite("shared PostgreSQL HTTP policy stores", () => {
  let sql: SQL;
  let database: HttpPolicyDatabase;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/supacloud_commands_test") {
      throw new Error("Use a dedicated loopback supacloud_commands_test database");
    }
    sql = new SQL(connection!);
    await sql.unsafe(HTTP_POLICY_STORE_SQL);
    database = { query: async (text, parameters) => {
      const rows = await sql.unsafe(text, [...parameters]);
      return Array.from(rows) as Record<string, unknown>[];
    } };
  });
  afterAll(async () => { await sql?.close(); });
  const key = () => crypto.randomUUID().replaceAll("-", "").repeat(2);

  test("two instances share one atomic quota under concurrent requests and reset after expiry", async () => {
    const first = createPostgresHttpPolicyStores(database), second = createPostgresHttpPolicyStores(database);
    const id = key();
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      (i % 2 ? first : second).rateLimitStore.consume(id, 3, 60000)));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.every((result) => result.remaining >= 0)).toBe(true);
    await sql.unsafe("UPDATE supacloud_http.rate_limits SET reset_at=now()-interval '1 second' WHERE key=$1", [id]);
    expect((await second.rateLimitStore.consume(id, 3, 1000)).allowed).toBe(true);
  });

  test("shared cache survives store recreation, expires and explicitly invalidates", async () => {
    const first = createPostgresHttpPolicyStores(database), second = createPostgresHttpPolicyStores(database);
    const id = key();
    const value = { body: '{"ok":true}', contentType: "application/json", expiresAt: Date.now() + 60000 };
    const generation = await first.cacheStore.generation();
    await first.cacheStore.set(id, value, generation);
    expect(await second.cacheStore.get(id, generation)).toEqual(value);
    await sql.unsafe("UPDATE supacloud_http.response_cache SET expires_at=now()-interval '1 second' WHERE key=$1", [id]);
    expect(await second.cacheStore.get(id, generation)).toBeUndefined();
    await second.prune();
    const rows = await database.query("SELECT key FROM supacloud_http.response_cache WHERE key=$1", [id]);
    expect(rows).toEqual([]);
    await first.cacheStore.set(id, value, generation);
    await second.cacheStore.clear();
    expect(await first.cacheStore.get(id, await first.cacheStore.generation())).toBeUndefined();
    await first.cacheStore.set(id, value, generation);
    expect(await first.cacheStore.get(id, await first.cacheStore.generation())).toBeUndefined();
  });

  test("a waiter crossing expiry uses one clock observation after acquiring the row lock", async () => {
    const stores = createPostgresHttpPolicyStores(database);
    const id = key();
    await stores.rateLimitStore.consume(id, 1, 60000);
    let waiting: Promise<unknown> | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SELECT key FROM supacloud_http.rate_limits WHERE key=$1 FOR UPDATE", [id]);
      waiting = Promise.resolve(stores.rateLimitStore.consume(id, 1, 60000));
      let locked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await database.query(`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM supacloud_http.consume_rate_limit%'
        `, []);
        if (Number(rows[0]?.count) > 0) { locked = true; break; }
        await Bun.sleep(10);
      }
      expect(locked).toBe(true);
      await tx.unsafe("UPDATE supacloud_http.rate_limits SET reset_at=clock_timestamp() WHERE key=$1", [id]);
    });
    expect(await waiting).toMatchObject({ allowed: true, remaining: 0 });
  });

  test("cache generation checking and write are atomic against concurrent invalidation", async () => {
    const stores = createPostgresHttpPolicyStores(database);
    const id = key(), generation = await stores.cacheStore.generation();
    const value = { body: '{"old":true}', contentType: "application/json", expiresAt: Date.now() + 60000 };
    const fillClient = new SQL(connection!, { max: 1 });
    try {
      const [backend] = await fillClient.unsafe("SELECT pg_backend_pid() AS pid");
      const fillStores = createPostgresHttpPolicyStores({
        query: async (text, parameters) => Array.from(await fillClient.unsafe(text, [...parameters])),
      });
      let waiting: Promise<void> | undefined;
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT generation FROM supacloud_http.cache_generation WHERE singleton FOR UPDATE");
        waiting = Promise.resolve(fillStores.cacheStore.set(id, value, generation));
        let locked = false;
        for (let i = 0; i < 100; i++) {
          const [row] = await database.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [backend.pid]);
          if (row?.wait_event_type === "Lock") { locked = true; break; }
          await Bun.sleep(10);
        }
        expect(locked).toBe(true);
        await tx.unsafe("UPDATE supacloud_http.cache_generation SET generation=gen_random_uuid() WHERE singleton");
      });
      await waiting;
      expect(await stores.cacheStore.get(id, await stores.cacheStore.generation())).toBeUndefined();
      expect(await database.query("SELECT key FROM supacloud_http.response_cache WHERE key=$1", [id])).toEqual([]);
    } finally { await fillClient.close(); }
  });

  test("concurrent expiry pruning does not fail quota consumption", async () => {
    const stores = createPostgresHttpPolicyStores(database);
    const id = key();
    await stores.rateLimitStore.consume(id, 100, 60000);
    for (let round = 0; round < 20; round++) {
      await sql.unsafe("UPDATE supacloud_http.rate_limits SET reset_at=clock_timestamp()-interval '1 second' WHERE key=$1", [id]);
      const [first, second] = await Promise.all([
        stores.rateLimitStore.consume(id, 100, 60000),
        stores.rateLimitStore.consume(id, 100, 60000),
        stores.prune(),
      ]);
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
    }
  });

  test("invalid keys are rejected before SQL and store tables are not public", async () => {
    const stores = createPostgresHttpPolicyStores(database);
    await expect(stores.rateLimitStore.consume("injection", 1, 100)).rejects.toThrow("SHA-256");
    const rows = await database.query(`
      SELECT has_schema_privilege('anon', 'supacloud_http', 'USAGE') AS allowed
    `, []);
    expect(rows).toEqual([{ allowed: false }]);
  });
});
