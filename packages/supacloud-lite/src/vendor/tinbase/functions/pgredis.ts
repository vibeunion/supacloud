import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database, Querier } from '../db/database.js'

const CACHE_NAMESPACE = 'supacloud-edge-runtime'
const CACHE_TABLE = 'public.supacloud_pgredis_kv'
const MAX_KEY_CHARACTERS = 512
const MAX_VALUE_BYTES = 1_048_576
const MAX_TTL_MS = 31_536_000_000

const CACHE_SCHEMA_SQL = `
create table if not exists ${CACHE_TABLE} (
  namespace text not null,
  key text not null,
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (namespace, key)
);

create index if not exists supacloud_pgredis_kv_expires_at_idx
  on ${CACHE_TABLE} (expires_at) where expires_at is not null;
`

const CACHE_PERMISSIONS_SQL = `
revoke all on table ${CACHE_TABLE} from public, anon, authenticated, service_role;
`

interface StoredValueRow {
  serialized_value: string
}

interface TtlRow {
  ttl_ms: number | string | null
}

/** Persistent, single-project implementation of the Edge Runtime pgredis contract. */
export class PgredisCache {
  private constructor(private db: Database) {}

  static async create(db: Database): Promise<PgredisCache> {
    await db.exec(CACHE_SCHEMA_SQL)
    if (!db.engine.minimalBootstrap) await db.exec(CACHE_PERMISSIONS_SQL)
    return new PgredisCache(db)
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    assertCacheKey(key)
    return this.db.transaction(async (query) => {
      await deleteExpiredKey(query, key)
      const stored = await query<StoredValueRow>(
        `select value::text as serialized_value from ${CACHE_TABLE} where namespace = $1 and key = $2`,
        [CACHE_NAMESPACE, key]
      )
      return stored.rows[0] ? parseStoredValue<T>(stored.rows[0]) : null
    })
  }

  async set<T = unknown>(key: string, cacheValue: T, ttlMs?: number | null): Promise<boolean> {
    assertCacheKey(key)
    assertTtl(ttlMs)
    const serializedValue = serializeCacheValue(cacheValue)
    await this.db.query(
      `insert into ${CACHE_TABLE} (namespace, key, value, expires_at, updated_at)
       values ($1, $2, $3::jsonb,
         case when $4::bigint is null then null else clock_timestamp() + $4::double precision * interval '1 millisecond' end,
         now())
       on conflict (namespace, key) do update set
         value = excluded.value, expires_at = excluded.expires_at, updated_at = now()`,
      [CACHE_NAMESPACE, key, serializedValue, ttlMs ?? null]
    )
    return true
  }

  async delete(key: string): Promise<boolean> {
    assertCacheKey(key)
    return this.db.transaction(async (query) => {
      await deleteExpiredKey(query, key)
      const deleted = await query(
        `delete from ${CACHE_TABLE} where namespace = $1 and key = $2 returning key`,
        [CACHE_NAMESPACE, key]
      )
      return deleted.rows.length > 0
    })
  }

  async ttl(key: string): Promise<number | null> {
    assertCacheKey(key)
    return this.db.transaction(async (query) => {
      await deleteExpiredKey(query, key)
      const stored = await query<TtlRow>(
        `select case when expires_at is null then null
          else greatest(0, ceil(extract(epoch from (expires_at - clock_timestamp())) * 1000))::bigint
        end as ttl_ms from ${CACHE_TABLE} where namespace = $1 and key = $2`,
        [CACHE_NAMESPACE, key]
      )
      const ttlMs = stored.rows[0]?.ttl_ms
      return ttlMs === null || ttlMs === undefined ? null : Number(ttlMs)
    })
  }

  async getset<T = unknown>(key: string, cacheValue: T): Promise<T | null> {
    assertCacheKey(key)
    const serializedValue = serializeCacheValue(cacheValue)
    return this.db.transaction(async (query) => {
      await deleteExpiredKey(query, key)
      const previous = await query<StoredValueRow>(
        `select value::text as serialized_value from ${CACHE_TABLE}
         where namespace = $1 and key = $2 for update`,
        [CACHE_NAMESPACE, key]
      )
      await upsertWithoutTtl(query, key, serializedValue)
      return previous.rows[0] ? parseStoredValue<T>(previous.rows[0]) : null
    })
  }

  async getdel<T = unknown>(key: string): Promise<T | null> {
    assertCacheKey(key)
    return this.db.transaction(async (query) => {
      await deleteExpiredKey(query, key)
      const deleted = await query<StoredValueRow>(
        `delete from ${CACHE_TABLE} where namespace = $1 and key = $2 returning value::text as serialized_value`,
        [CACHE_NAMESPACE, key]
      )
      return deleted.rows[0] ? parseStoredValue<T>(deleted.rows[0]) : null
    })
  }
}

export interface PgredisCacheBinding {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, cacheValue: T, ttlMs?: number | null): Promise<boolean>
  delete(key: string): Promise<boolean>
  ttl(key: string): Promise<number | null>
  getset<T = unknown>(key: string, cacheValue: T): Promise<T | null>
  getdel<T = unknown>(key: string): Promise<T | null>
}

interface ActiveCacheContext {
  cache: PgredisCache
  active: boolean
}

const cacheContexts = new AsyncLocalStorage<ActiveCacheContext>()

const cacheFacade: PgredisCacheBinding = Object.freeze({
  get: async <T = unknown>(key: string) => activeCache().get<T>(key),
  set: async <T = unknown>(key: string, cacheValue: T, ttlMs?: number | null) =>
    activeCache().set(key, cacheValue, ttlMs),
  delete: async (key: string) => activeCache().delete(key),
  ttl: async (key: string) => activeCache().ttl(key),
  getset: async <T = unknown>(key: string, cacheValue: T) => activeCache().getset<T>(key, cacheValue),
  getdel: async <T = unknown>(key: string) => activeCache().getdel<T>(key),
})

/** Install the immutable global binding used by SupaCloud Edge Functions. */
export function installPgredisShim(): void {
  const runtime = globalThis as typeof globalThis & { SupaCloud?: { pgredis?: PgredisCacheBinding } }
  if (runtime.SupaCloud?.pgredis) {
    if (runtime.SupaCloud.pgredis === cacheFacade) return
    throw new Error('globalThis.SupaCloud.pgredis is already owned by another runtime')
  }
  Object.defineProperty(runtime, 'SupaCloud', {
    configurable: false,
    enumerable: true,
    value: Object.freeze({ ...(runtime.SupaCloud ?? {}), pgredis: cacheFacade }),
    writable: false,
  })
}

/** Bind one function invocation to its project's cache and revoke it when the response settles. */
export function runWithPgredisCache<T>(cache: PgredisCache, operation: () => Promise<T>): Promise<T> {
  const context: ActiveCacheContext = { cache, active: true }
  return cacheContexts.run(context, async () => {
    try {
      return await operation()
    } finally {
      context.active = false
    }
  })
}

function activeCache(): PgredisCache {
  const context = cacheContexts.getStore()
  if (!context?.active) throw new Error('pgredis binding is unavailable outside a function request')
  return context.cache
}

function assertCacheKey(key: string): void {
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_CHARACTERS) {
    throw new TypeError(`pgredis key must contain between 1 and ${MAX_KEY_CHARACTERS} characters`)
  }
}

function assertTtl(ttlMs: number | null | undefined): void {
  if (ttlMs === null || ttlMs === undefined) return
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new TypeError('pgredis ttlMs must be a non-negative safe integer or null')
  if (ttlMs > MAX_TTL_MS) throw new RangeError(`pgredis ttlMs must not exceed ${MAX_TTL_MS}`)
}

function serializeCacheValue(cacheValue: unknown): string {
  const serializedValue = JSON.stringify(cacheValue)
  if (serializedValue === undefined) throw new TypeError('pgredis value must be JSON serializable')
  if (new TextEncoder().encode(serializedValue).byteLength > MAX_VALUE_BYTES) {
    throw new RangeError(`pgredis value must not exceed ${MAX_VALUE_BYTES} bytes`)
  }
  return serializedValue
}

function parseStoredValue<T>(stored: StoredValueRow): T {
  return JSON.parse(stored.serialized_value) as T
}

async function deleteExpiredKey(query: Querier, key: string): Promise<void> {
  await query(
    `delete from ${CACHE_TABLE} where namespace = $1 and key = $2 and expires_at <= clock_timestamp()`,
    [CACHE_NAMESPACE, key]
  )
}

async function upsertWithoutTtl(query: Querier, key: string, serializedValue: string): Promise<void> {
  await query(
    `insert into ${CACHE_TABLE} (namespace, key, value, expires_at, updated_at)
     values ($1, $2, $3::jsonb, null, now())
     on conflict (namespace, key) do update set value = excluded.value, expires_at = null, updated_at = now()`,
    [CACHE_NAMESPACE, key, serializedValue]
  )
}
