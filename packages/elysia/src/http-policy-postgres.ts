import type { HttpCacheStore, HttpRateLimitStore } from "./http-policy-stores";

export interface HttpPolicyDatabase {
  query(text: string, parameters: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/** Apply through migrations, never from a request. Credentials must be server-only. */
export const HTTP_POLICY_STORE_SQL = `
CREATE SCHEMA IF NOT EXISTS supacloud_http;
REVOKE ALL ON SCHEMA supacloud_http FROM PUBLIC;
CREATE TABLE IF NOT EXISTS supacloud_http.rate_limits (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  used bigint NOT NULL CHECK (used > 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS http_rate_limit_expiry ON supacloud_http.rate_limits(reset_at);
CREATE TABLE IF NOT EXISTS supacloud_http.response_cache (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  body text NOT NULL CHECK (octet_length(body) <= 16777216),
  expires_at timestamptz NOT NULL,
  generation uuid NOT NULL
);
ALTER TABLE supacloud_http.response_cache ADD COLUMN IF NOT EXISTS generation uuid
  NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
CREATE TABLE IF NOT EXISTS supacloud_http.cache_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO supacloud_http.cache_generation(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS http_response_cache_expiry ON supacloud_http.response_cache(expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_http FROM PUBLIC;
CREATE OR REPLACE FUNCTION supacloud_http.consume_rate_limit(p_key text, p_limit bigint, p_window_ms integer)
RETURNS TABLE(allowed boolean, remaining bigint, reset_at_ms numeric)
LANGUAGE plpgsql SET search_path = pg_catalog, supacloud_http AS $rate$
DECLARE
  entry supacloud_http.rate_limits%ROWTYPE;
  observed_at timestamptz;
BEGIN
  IF p_limit < 1 OR p_limit > 1000000000 OR p_window_ms < 1 OR p_window_ms > 86400000 THEN
    RAISE EXCEPTION 'Invalid rate limit window';
  END IF;
  LOOP
    INSERT INTO supacloud_http.rate_limits(key, used, reset_at)
      VALUES (p_key, 1, '-infinity') ON CONFLICT DO NOTHING;
    SELECT * INTO entry FROM supacloud_http.rate_limits WHERE key=p_key FOR UPDATE;
    EXIT WHEN FOUND;
    -- Expiry pruning may remove a conflicting row before we acquire its lock.
  END LOOP;
  observed_at := clock_timestamp();
  IF entry.reset_at <= observed_at THEN
    entry.used := 1;
    entry.reset_at := observed_at + p_window_ms * interval '1 millisecond';
  ELSE
    entry.used := least(entry.used + 1, p_limit + 1);
  END IF;
  UPDATE supacloud_http.rate_limits SET used=entry.used, reset_at=entry.reset_at WHERE key=p_key;
  RETURN QUERY SELECT entry.used <= p_limit, greatest(p_limit-entry.used,0),
    extract(epoch FROM entry.reset_at)*1000;
END
$rate$;
REVOKE ALL ON FUNCTION supacloud_http.consume_rate_limit(text,bigint,integer) FROM PUBLIC;
`;

function validKey(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError("HTTP store keys must be SHA-256 digests");
}

/** Independent instances sharing a database share atomic quotas and private cache entries. */
export function createPostgresHttpPolicyStores(database: HttpPolicyDatabase): {
  rateLimitStore: HttpRateLimitStore;
  cacheStore: HttpCacheStore;
  prune(): Promise<void>;
} {
  const rateLimitStore: HttpRateLimitStore = {
    async consume(key, limit, windowMs) {
      validKey(key);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000_000_000
        || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 86_400_000) {
        throw new TypeError("Invalid rate limit window");
      }
      const [row] = await database.query(
        "SELECT * FROM supacloud_http.consume_rate_limit($1,$2,$3)", [key, limit, windowMs],
      );
      if (!row || typeof row.allowed !== "boolean") throw new Error("Invalid rate limit storage result");
      return { allowed: row.allowed, remaining: Number(row.remaining), resetAt: Number(row.reset_at_ms) };
    },
  };
  const cacheStore: HttpCacheStore = {
    async generation() {
      const [row] = await database.query("SELECT generation FROM supacloud_http.cache_generation WHERE singleton", []);
      if (!row || typeof row.generation !== "string") throw new Error("Invalid cache generation");
      return row.generation;
    },
    async get(key, generation) {
      validKey(key);
      const [row] = await database.query(`
        SELECT body, extract(epoch FROM expires_at) * 1000 AS expires_at_ms
        FROM supacloud_http.response_cache AS cache
        JOIN supacloud_http.cache_generation AS current ON cache.generation = current.generation
        WHERE key = $1 AND cache.generation = $2::uuid AND expires_at > clock_timestamp()
      `, [key, generation]);
      if (!row) return;
      if (typeof row.body !== "string") throw new Error("Invalid cache storage result");
      return { body: row.body, contentType: "application/json", expiresAt: Number(row.expires_at_ms) };
    },
    async set(key, value, generation) {
      validKey(key);
      if (value.contentType !== "application/json" || typeof value.body !== "string"
        || new TextEncoder().encode(value.body).byteLength > 16_777_216
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
        throw new TypeError("Invalid cache entry");
      }
      await database.query(`
        WITH current AS MATERIALIZED (
          SELECT generation FROM supacloud_http.cache_generation
          WHERE singleton AND generation=$4::uuid FOR SHARE
        )
        INSERT INTO supacloud_http.response_cache (key, body, expires_at, generation)
        SELECT $1, $2, to_timestamp($3 / 1000.0), generation FROM current
        ON CONFLICT (key) DO UPDATE SET body = excluded.body,
          expires_at = excluded.expires_at, generation = excluded.generation
      `, [key, value.body, value.expiresAt, generation]);
    },
    async clear() {
      await database.query(`
        WITH advanced AS (
          UPDATE supacloud_http.cache_generation SET generation=gen_random_uuid() WHERE singleton RETURNING generation
        )
        DELETE FROM supacloud_http.response_cache WHERE EXISTS(SELECT 1 FROM advanced)
      `, []);
    },
  };
  return {
    rateLimitStore, cacheStore,
    async prune() {
      await database.query("DELETE FROM supacloud_http.rate_limits WHERE reset_at <= clock_timestamp()", []);
      await database.query("DELETE FROM supacloud_http.response_cache WHERE expires_at <= clock_timestamp()", []);
    },
  };
}
