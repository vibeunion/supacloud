import { describe, expect, it } from "bun:test";
import { resource } from "./resource";
import { signal } from "./signal";

describe("Angular 19-style resource() reactive data API", () => {
  it("initializes with initialValue and resolves async data", async () => {
    const res = resource({
      initialValue: "initial",
      loader: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "fetched";
      },
    });

    expect(res.value()).toBe("initial");
    expect(res.status()).toBe("loading");
    expect(res.isLoading()).toBe(true);

    await new Promise((r) => setTimeout(r, 30));

    expect(res.value()).toBe("fetched");
    expect(res.status()).toBe("resolved");
    expect(res.isLoading()).toBe(false);
    expect(res.error()).toBeUndefined();
    res.destroy();
  });

  it("reactively re-fetches when request signal dependency changes", async () => {
    const userId = signal(101);
    const fetchedIds: number[] = [];

    const userResource = resource({
      request: () => userId(),
      loader: async ({ request }) => {
        fetchedIds.push(request);
        return { id: request, name: `User ${request}` };
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(userResource.value()).toEqual({ id: 101, name: "User 101" });
    expect(fetchedIds).toEqual([101]);

    // Change request signal
    userId.set(102);
    await new Promise((r) => setTimeout(r, 20));

    expect(userResource.value()).toEqual({ id: 102, name: "User 102" });
    expect(fetchedIds).toEqual([101, 102]);
    userResource.destroy();
  });

  it("captures loader errors and transitions to error status", async () => {
    const failingResource = resource({
      loader: async () => {
        throw new Error("Network unreachable");
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(failingResource.status()).toBe("error");
    expect(failingResource.isLoading()).toBe(false);
    expect((failingResource.error() as Error).message).toBe("Network unreachable");
    failingResource.destroy();
  });

  it("supports manual reload(), set(), and update()", async () => {
    let loadCount = 0;
    const counterResource = resource({
      loader: async () => {
        loadCount += 1;
        return loadCount;
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(counterResource.value()).toBe(1);

    // Manual reload
    counterResource.reload();
    await new Promise((r) => setTimeout(r, 20));
    expect(counterResource.value()).toBe(2);

    // Direct set
    counterResource.set(100);
    expect(counterResource.value()).toBe(100);
    expect(counterResource.status()).toBe("resolved");

    // Direct update
    counterResource.update((curr) => (curr ?? 0) + 5);
    expect(counterResource.value()).toBe(105);
    counterResource.destroy();
  });

  it("passes AbortSignal and aborts previous pending requests", async () => {
    const query = signal("first");
    const abortedQueries: string[] = [];

    const searchResource = resource({
      request: () => query(),
      loader: async ({ request, abortSignal }) => {
        abortSignal.addEventListener("abort", () => {
          abortedQueries.push(request);
        });
        await new Promise((r) => setTimeout(r, 50));
        return `Result for ${request}`;
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    // Rapidly change query before first request finishes
    query.set("second");

    await new Promise((r) => setTimeout(r, 80));
    expect(abortedQueries).toContain("first");
    expect(searchResource.value()).toBe("Result for second");
    searchResource.destroy();
  });
});
