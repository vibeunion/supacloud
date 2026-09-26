export interface HttpRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface HttpRateLimitStore {
  /** Must atomically consume one request across every process sharing this store. */
  consume(key: string, limit: number, windowMs: number): HttpRateLimitResult | Promise<HttpRateLimitResult>;
}

export interface HttpCacheEntry {
  body: string;
  contentType: string;
  expiresAt: number;
}

export interface HttpCacheStore {
  generation(): string | Promise<string>;
  get(key: string, generation: string): HttpCacheEntry | undefined | Promise<HttpCacheEntry | undefined>;
  /** Atomically refuse fills from an invalidated generation. */
  set(key: string, value: HttpCacheEntry, generation: string): void | Promise<void>;
  /** Invalidation is explicit, never inferred from a write that may have failed. */
  clear(): void | Promise<void>;
}

function capacity(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Store capacity must be a positive integer");
}

/** Single-process fixed windows. Capacity exhaustion fails closed, not quota eviction. */
export function createMemoryHttpRateLimitStore(options: { maxEntries?: number; now?: () => number } = {}): HttpRateLimitStore {
  const maxEntries = options.maxEntries ?? 10_000;
  capacity(maxEntries);
  const now = options.now ?? Date.now;
  const entries = new Map<string, { used: number; resetAt: number }>();
  return {
    consume(key, limit, windowMs) {
      capacity(limit);
      capacity(windowMs);
      const time = now();
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= time) {
        if (!entry && entries.size >= maxEntries) {
          for (const [expiredKey, value] of entries) {
            if (value.resetAt <= time) entries.delete(expiredKey);
          }
          if (entries.size >= maxEntries) throw new Error("Rate limit store capacity exhausted");
        }
        entry = { used: 0, resetAt: time + windowMs };
        entries.set(key, entry);
      }
      const allowed = entry.used < limit;
      if (allowed) entry.used++;
      return { allowed, remaining: Math.max(0, limit - entry.used), resetAt: entry.resetAt };
    },
  };
}

/** Bounded local LRU; use a shared store for cross-process caching/invalidation. */
export function createMemoryHttpCacheStore(options: {
  maxEntries?: number; maxBytes?: number; now?: () => number;
} = {}): HttpCacheStore {
  const maxEntries = options.maxEntries ?? 1_000, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  capacity(maxEntries);
  capacity(maxBytes);
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: HttpCacheEntry; bytes: number }>();
  let generation = crypto.randomUUID();
  let bytes = 0;
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  };
  return {
    generation: () => generation,
    get(key, expected) {
      if (expected !== generation) return;
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.value.expiresAt <= now()) { remove(key); return; }
      entries.delete(key);
      entries.set(key, entry);
      return { ...entry.value };
    },
    set(key, value, expected) {
      if (expected !== generation) return;
      const size = new TextEncoder().encode(key + value.body + value.contentType).byteLength;
      if (size > maxBytes || value.expiresAt <= now()) return;
      remove(key);
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      entries.set(key, { value: { ...value }, bytes: size });
      bytes += size;
    },
    clear() { generation = crypto.randomUUID(); entries.clear(); bytes = 0; },
  };
}
