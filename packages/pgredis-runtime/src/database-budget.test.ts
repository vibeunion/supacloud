import { describe, expect, test } from "bun:test";
import type { PgSqlLike } from "@postgresx/noredis";
import { createBudgetedAdapter, createDatabaseBudget } from "./database-budget";

describe("createDatabaseBudget", () => {
  test("rejects invalid limits", () => {
    expect(() => createDatabaseBudget(0)).toThrow("positive integer");
    expect(() => createDatabaseBudget(1.5)).toThrow("positive integer");
  });

  test("bounds in-flight permits and queues the rest", async () => {
    const budget = createDatabaseBudget(2);
    const releaseA = await budget.acquire();
    const releaseB = await budget.acquire();
    expect(budget.inFlight()).toBe(2);

    let thirdAcquired = false;
    const third = budget.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await Bun.sleep(0);
    expect(thirdAcquired).toBeFalse();

    releaseA();
    const releaseC = await third;
    expect(thirdAcquired).toBeTrue();
    expect(budget.inFlight()).toBe(2);

    releaseB();
    releaseC();
    expect(budget.inFlight()).toBe(0);
  });

  test("release is idempotent", async () => {
    const budget = createDatabaseBudget(1);
    const release = await budget.acquire();
    release();
    release();
    expect(budget.inFlight()).toBe(0);
  });
});

describe("createBudgetedAdapter", () => {
  test("holds one permit per statement and one per transaction", async () => {
    const budget = createDatabaseBudget(1);
    const queries: string[] = [];
    const adapter = createBudgetedAdapter({
      async unsafe<T>(query: string): Promise<T[]> {
        queries.push(query);
        return [];
      },
      async begin<T>(operation: (transaction: PgSqlLike) => Promise<T>): Promise<T> {
        return operation({ async unsafe<U>(): Promise<U[]> { return []; } });
      },
    }, budget);

    await adapter.unsafe("SELECT 1");
    expect(budget.inFlight()).toBe(0);

    await adapter.begin?.(async () => {
      expect(budget.inFlight()).toBe(1);
    });
    expect(budget.inFlight()).toBe(0);
    expect(queries).toEqual(["SELECT 1"]);
  });

  test("omits begin when the wrapped adapter has none", () => {
    const budget = createDatabaseBudget(1);
    const adapter = createBudgetedAdapter({
      async unsafe<T>(): Promise<T[]> {
        return [];
      },
    }, budget);
    expect(adapter.begin).toBeUndefined();
  });
});