import { describe, expect, mock, test } from "bun:test";
import { withRetry } from "../../src/utils/retry";

describe("withRetry", () => {
  test("returns result on first try success", async () => {
    const fn = mock(() => Promise.resolve("ok"));
    const result = await withRetry("test-op", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and succeeds on 2nd attempt", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "recovered";
    });

    const result = await withRetry("test-op", fn, {
      maxRetries: 3,
      initialDelayMs: 1,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws after exhausting all retries", async () => {
    const fn = mock(async () => {
      throw new Error("permanent failure");
    });

    await expect(
      withRetry("test-op", fn, { maxRetries: 2, initialDelayMs: 1 })
    ).rejects.toThrow("permanent failure");

    // 1 initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("respects shouldRetry predicate — stops early when false", async () => {
    const fn = mock(async () => {
      throw new Error("non-retryable");
    });

    await expect(
      withRetry("test-op", fn, {
        maxRetries: 5,
        initialDelayMs: 1,
        shouldRetry: () => false,
      })
    ).rejects.toThrow("non-retryable");

    // should retry said no → only 1 attempt
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("respects shouldRetry predicate — retries when true", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls <= 2) throw new Error("retryable");
      return "done";
    });

    const result = await withRetry("test-op", fn, {
      maxRetries: 5,
      initialDelayMs: 1,
      shouldRetry: (err) =>
        err instanceof Error && err.message === "retryable",
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("default maxRetries is 3", async () => {
    const fn = mock(async () => {
      throw new Error("fail");
    });

    await expect(
      withRetry("test-op", fn, { initialDelayMs: 1 })
    ).rejects.toThrow("fail");

    // 1 initial + 3 retries = 4
    expect(fn).toHaveBeenCalledTimes(4);
  });

  test("applies exponential backoff (delay increases)", async () => {
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount <= 3) throw new Error("fail");
      return "ok";
    });

    const result = await withRetry("test-op", fn, {
      maxRetries: 5,
      initialDelayMs: 10,
      backoffFactor: 2,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  test("propagates non-Error throwables", async () => {
    const fn = mock(() => Promise.reject("string error"));

    await expect(
      withRetry("test-op", fn, { maxRetries: 1, initialDelayMs: 1 })
    ).rejects.toBe("string error");
  });
});
