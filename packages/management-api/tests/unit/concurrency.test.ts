import { expect, test } from "bun:test";
import { mapWithConcurrency, parseConcurrency } from "../../src/utils/concurrency";

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid concurrency %s before invoking a mapper",
  async (concurrency) => {
    let calls = 0;
    await expect(mapWithConcurrency([1], concurrency, async () => ++calls)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
    expect(() => parseConcurrency(String(concurrency), 12)).toThrow(RangeError);
  },
);

test("parses concurrency without masking invalid configured values", () => {
  expect(parseConcurrency(undefined, 12)).toBe(12);
  expect(parseConcurrency("", 12)).toBe(12);
  expect(parseConcurrency("2", 12)).toBe(2);
  expect(() => parseConcurrency("invalid", 12)).toThrow(RangeError);
  expect(() => parseConcurrency(undefined, 0)).toThrow(RangeError);
});

test("preserves input order while limiting concurrent work", async () => {
  let active = 0;
  let maximum = 0;
  const releases = new Map<number, () => void>();
  const result = mapWithConcurrency([1, 2, 3], 2, async (value) => {
    maximum = Math.max(maximum, ++active);
    await new Promise<void>((resolve) => { releases.set(value, resolve); });
    active--;
    return value * 10;
  });
  expect([...releases.keys()]).toEqual([1, 2]);
  releases.get(2)?.();
  await Promise.resolve();
  await Promise.resolve();
  expect([...releases.keys()]).toEqual([1, 2, 3]);
  releases.get(3)?.();
  releases.get(1)?.();
  expect(await result).toEqual([10, 20, 30]);
  expect(maximum).toBe(2);
});

test("takes a snapshot before mapper mutations and supports explicit undefined", async () => {
  const source: Array<number | undefined> = [1, undefined, 3];
  const result = mapWithConcurrency(source, 1, async (value) => {
    source.length = 0;
    return value;
  });
  expect(await result).toEqual([1, undefined, 3]);
  expect(await mapWithConcurrency([], 1, async (value) => value)).toEqual([]);
  await expect(mapWithConcurrency(new Array<number>(2), 1, async (value) => value))
    .rejects.toThrow("must not be sparse");
});

test("stops scheduling after failure and waits for already-started side effects", async () => {
  const started: number[] = [];
  let finished = false;
  let reported = false;
  const release = Promise.withResolvers<void>();
  const result = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    started.push(value);
    if (value === 1) throw undefined;
    await release.promise;
    finished = true;
    return value;
  });
  const outcome = result.then(
    () => { throw new Error("Expected failure"); },
    (reason: unknown) => { reported = true; return { reason }; },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  expect(reported).toBe(false);
  release.resolve();
  expect(await outcome).toEqual({ reason: undefined });
  expect(finished).toBe(true);
  expect(started).toEqual([1, 2]);
});
