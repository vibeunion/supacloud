import { expect, test } from "bun:test";
import { createAuthenticatedFetch, createCommandScope } from "./client";
import {
  createDurableCommandLocks,
  type CommandLockCoordinator, type CommandLockStorage,
} from "./browser";

function storage(): CommandLockStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

function coordinator(): CommandLockCoordinator {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    exclusive(name, task) {
      expect(name).toContain("locks:");
      const result = pending.then(task);
      pending = result.catch(() => undefined);
      return result;
    },
  };
}

test("a destroyed or superseded attempt cannot commit state", () => {
  let updates = 0;
  const scope = createCommandScope();
  const first = scope.begin("first");
  const second = scope.begin("second");
  expect(first.signal.aborted).toBe(true);
  expect(first.commit(() => { updates++; })).toBe(false);
  expect(second.commit(() => { updates++; })).toBe(true);
  scope.destroy();
  expect(second.signal.aborted).toBe(true);
  expect(second.commit(() => { updates++; })).toBe(false);
  expect(updates).toBe(1);
  expect(() => scope.begin("third")).toThrow("destroyed");
});

test("persistent locks survive page replacement and reject stale release even after waiting", async () => {
  const store = storage(), mutex = coordinator();
  const oldPage = createCommandScope(), newPage = createCommandScope();
  const oldAttempt = oldPage.begin("old");
  const locks = createDurableCommandLocks({ namespace: "locks", storage: store, coordinator: mutex });
  expect((await locks.acquire("webhook", "old")).acquired).toBe(true);
  const oldRelease = locks.release("webhook", "old", oldAttempt.isCurrent);
  oldPage.destroy();
  const restored = createDurableCommandLocks({ namespace: "locks", storage: store, coordinator: mutex });
  const nextAttempt = newPage.begin("old");
  expect(await oldRelease).toBe(false);
  expect((await restored.get("webhook"))?.operationId).toBe("old");
  expect(await restored.release("webhook", "different", nextAttempt.isCurrent)).toBe(false);
  expect(await restored.release("webhook", "old", nextAttempt.isCurrent)).toBe(true);
  expect(await restored.get("webhook")).toBeNull();
});

test("shared coordinator permits only one concurrent lock owner", async () => {
  const options = { namespace: "locks", storage: storage(), coordinator: coordinator() };
  const first = createDurableCommandLocks(options), second = createDurableCommandLocks(options);
  const outcomes = await Promise.all([first.acquire("same", "a"), second.acquire("same", "b")]);
  expect(outcomes.filter((item) => item.acquired)).toHaveLength(1);
  expect(outcomes[0]?.lock).toEqual(outcomes[1]?.lock);
});

test("invalid or unavailable storage fails closed and never silently removes a lock", async () => {
  let removals = 0;
  for (const value of ["{}", "bad-json", '{"version":2,"target":"x","operationId":"a"}']) {
    const locks = createDurableCommandLocks({
      namespace: "locks", coordinator: coordinator(),
      storage: { getItem: () => value, setItem: () => {}, removeItem: () => { removals++; } },
    });
    await expect(locks.acquire("x", "a")).rejects.toMatchObject({ code: "COMMAND_LOCK_UNAVAILABLE" });
    await expect(locks.release("x", "a", () => true)).rejects.toMatchObject({ code: "COMMAND_LOCK_UNAVAILABLE" });
  }
  expect(removals).toBe(0);
});

test("authenticated fetch acquires current token once, preserves credentials and never replays a 401", async () => {
  let tokens = 0, sends = 0;
  const send = createAuthenticatedFetch({
    getAccessToken: async () => { tokens++; return "current"; },
    fetch: async (input, init) => {
      sends++;
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer current");
      expect(request.credentials).toBe("include");
      expect(request.redirect).toBe("error");
      expect(await request.text()).toBe('{"enabled":true}');
      return new Response(null, { status: 401 });
    },
  });
  expect((await send("https://example.test/write", {
    method: "PUT", credentials: "include", body: '{"enabled":true}',
  })).status).toBe(401);
  expect([tokens, sends]).toEqual([1, 1]);
});

test("missing sessions, insecure URLs and aborted token acquisition never send", async () => {
  let sends = 0;
  const missing = createAuthenticatedFetch({
    getAccessToken: async () => null, fetch: async () => { sends++; return new Response(); },
  });
  await expect(missing("https://example.test/write")).rejects.toMatchObject({ code: "COMMAND_AUTHENTICATION_REQUIRED" });
  await expect(missing("http://example.test/write")).rejects.toThrow("HTTPS");
  const controller = new AbortController();
  const aborted = createAuthenticatedFetch({
    getAccessToken: async () => { controller.abort(); return "token"; },
    fetch: async () => { sends++; return new Response(); },
  });
  await expect(aborted("https://example.test/write", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(sends).toBe(0);
});
