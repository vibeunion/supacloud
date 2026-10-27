import { describe, expect, test } from "bun:test";
import {
  FRONTEND_RELEASE_POINTER_SCHEMA,
  parseFrontendReleasePointer,
  watchFrontendRelease,
  type FrontendReleasePointer,
} from "./frontend_update";

const RELEASE_A = "a".repeat(64);
const RELEASE_B = "b".repeat(64);
const RELEASE_C = "c".repeat(64);

function pointer(releaseId: string): FrontendReleasePointer {
  return { schema: FRONTEND_RELEASE_POINTER_SCHEMA, release_id: releaseId };
}

function sequenceFetch(releases: string[]) {
  let index = 0;
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    const releaseId = releases[Math.min(index, releases.length - 1)]!;
    index += 1;
    return Response.json(pointer(releaseId));
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("frontend release pointer", () => {
  test("parses only the documented pointer contract", () => {
    expect(parseFrontendReleasePointer(pointer(RELEASE_A))).toEqual(pointer(RELEASE_A));
    expect(() => parseFrontendReleasePointer({ ...pointer(RELEASE_A), extra: true })).toThrow();
    expect(() => parseFrontendReleasePointer({ schema: "other", release_id: RELEASE_A })).toThrow();
    expect(() => parseFrontendReleasePointer({ schema: FRONTEND_RELEASE_POINTER_SCHEMA, release_id: "../bad" })).toThrow();
  });

  test("reports each subsequent release once, without auto reload", async () => {
    const { fetcher, calls } = sequenceFetch([RELEASE_A, RELEASE_A, RELEASE_B, RELEASE_B, RELEASE_C]);
    const updates: Array<{ previousReleaseId: string; releaseId: string }> = [];
    const watcher = watchFrontendRelease({
      fetch: fetcher,
      intervalMs: 0,
      checkOnFocus: false,
      checkOnVisibility: false,
      dispatchEvent: false,
      autoReload: "never",
      onUpdate: ({ previousReleaseId, releaseId }) => updates.push({ previousReleaseId, releaseId }),
    });

    await watcher.check();
    expect(watcher.currentReleaseId()).toBe(RELEASE_A);
    await watcher.check();
    expect(updates).toEqual([]);
    await watcher.check();
    expect(updates).toEqual([{ previousReleaseId: RELEASE_A, releaseId: RELEASE_B }]);
    await watcher.check();
    expect(updates).toHaveLength(1);
    await watcher.check();
    expect(updates).toEqual([
      { previousReleaseId: RELEASE_A, releaseId: RELEASE_B },
      { previousReleaseId: RELEASE_B, releaseId: RELEASE_C },
    ]);
    expect(calls.every((url) => url === "/.well-known/supacloud-frontend-release")).toBe(true);

    watcher.stop();
  });

  test("keeps polling after a malformed pointer and establishes a later baseline", async () => {
    let attempt = 0;
    const errors: unknown[] = [];
    const fetcher = (async () => {
      attempt += 1;
      if (attempt === 1) return new Response("not-json", { status: 200 });
      return Response.json(pointer(attempt === 2 ? RELEASE_A : RELEASE_B));
    }) as unknown as typeof fetch;
    const updates: string[] = [];
    const watcher = watchFrontendRelease({
      fetch: fetcher,
      intervalMs: 0,
      checkOnFocus: false,
      checkOnVisibility: false,
      dispatchEvent: false,
      autoReload: "never",
      onUpdate: (update) => updates.push(update.releaseId),
      onError: (error) => errors.push(error),
    });

    expect(await watcher.check()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(watcher.currentReleaseId()).toBeNull();
    expect(await watcher.check()).toBeNull();
    expect(watcher.currentReleaseId()).toBe(RELEASE_A);
    expect(await watcher.check()).toMatchObject({ previousReleaseId: RELEASE_A, releaseId: RELEASE_B });
    expect(updates).toEqual([RELEASE_B]);

    watcher.stop();
  });
  test("auto reloads while hidden without any application wiring", async () => {
    const hadDocument = "document" in globalThis;
    const hadWindow = "window" in globalThis;
    const previousDocument = (globalThis as any).document;
    const previousWindow = (globalThis as any).window;
    const documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "hidden",
      activeElement: null,
      querySelector: () => null,
    });
    const windowTarget = new EventTarget();
    Object.defineProperty(globalThis, "document", { value: documentTarget, configurable: true });
    Object.defineProperty(globalThis, "window", { value: windowTarget, configurable: true });
    let reloads = 0;

    try {
      const { fetcher } = sequenceFetch([RELEASE_A, RELEASE_B]);
      const watcher = watchFrontendRelease({
        fetch: fetcher,
        intervalMs: 0,
        checkOnFocus: false,
        dispatchEvent: false,
        reload: () => { reloads += 1; },
      });

      await watcher.check();
      expect(reloads).toBe(0);
      await watcher.check();
      expect(reloads).toBe(1);
      await watcher.check();
      expect(reloads).toBe(1);
      watcher.stop();
    } finally {
      if (hadDocument) Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
      else delete (globalThis as any).document;
      if (hadWindow) Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      else delete (globalThis as any).window;
    }
  });

  test("auto reloads a visible idle page after the default grace period", async () => {
    const hadDocument = "document" in globalThis;
    const hadWindow = "window" in globalThis;
    const previousDocument = (globalThis as any).document;
    const previousWindow = (globalThis as any).window;
    const documentTarget = Object.assign(new EventTarget(), {
      visibilityState: "visible",
      activeElement: null,
      querySelector: () => null,
    });
    const windowTarget = new EventTarget();
    Object.defineProperty(globalThis, "document", { value: documentTarget, configurable: true });
    Object.defineProperty(globalThis, "window", { value: windowTarget, configurable: true });
    let reloads = 0;

    try {
      const { fetcher } = sequenceFetch([RELEASE_A, RELEASE_B]);
      const watcher = watchFrontendRelease({
        fetch: fetcher,
        intervalMs: 0,
        checkOnFocus: false,
        dispatchEvent: false,
        autoReloadIdleMs: 10,
        reload: () => { reloads += 1; },
      });

      await watcher.check();
      await watcher.check();
      expect(reloads).toBe(0);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(reloads).toBe(1);
      watcher.stop();
    } finally {
      if (hadDocument) Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
      else delete (globalThis as any).document;
      if (hadWindow) Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      else delete (globalThis as any).window;
    }
  });

});
