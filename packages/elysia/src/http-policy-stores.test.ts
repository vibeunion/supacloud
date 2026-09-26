import { expect, test } from "bun:test";
import { createMemoryHttpCacheStore, createMemoryHttpRateLimitStore } from "./index";

test("rate window boundary, expiry and active capacity fail closed", () => {
  let now = 0;
  const store = createMemoryHttpRateLimitStore({ maxEntries: 1, now: () => now });
  expect(store.consume("a", 1, 100)).toEqual({ allowed: true, remaining: 0, resetAt: 100 });
  now = 99;
  expect(store.consume("a", 1, 100)).toEqual({ allowed: false, remaining: 0, resetAt: 100 });
  expect(() => store.consume("b", 1, 100)).toThrow("capacity");
  now = 100;
  expect(store.consume("b", 1, 100)).toEqual({ allowed: true, remaining: 0, resetAt: 200 });
  expect(() => createMemoryHttpRateLimitStore({ maxEntries: 0 })).toThrow();
});

test("cache expires at deadline, bounds entries/bytes, clones metadata and supports invalidation", async () => {
  let now = 0;
  const store = createMemoryHttpCacheStore({ maxEntries: 2, maxBytes: 100, now: () => now });
  const generation = await store.generation();
  const entry = { body: "{}", contentType: "application/json", expiresAt: 100 };
  await store.set("a", entry, generation);
  entry.body = "changed";
  expect((await store.get("a", generation))?.body).toBe("{}");
  await store.set("b", { ...entry, body: "{}" }, generation);
  await store.get("a", generation);
  await store.set("c", { ...entry, body: "{}" }, generation);
  expect(await store.get("b", generation)).toBeUndefined();
  await store.set("large", { ...entry, body: "x".repeat(101) }, generation);
  expect(await store.get("large", generation)).toBeUndefined();
  now = 100;
  expect(await store.get("a", generation)).toBeUndefined();
  expect(await store.get("c", generation)).toBeUndefined();
  await store.set("d", { ...entry, expiresAt: 200 }, generation);
  await store.clear();
  expect(await store.get("d", await store.generation())).toBeUndefined();
  await store.set("stale", { ...entry, expiresAt: 200 }, generation);
  expect(await store.get("stale", await store.generation())).toBeUndefined();
  expect(() => createMemoryHttpCacheStore({ maxBytes: -1 })).toThrow();
});
