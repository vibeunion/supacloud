import { describe, expect, test } from "bun:test";
import { isDue } from "../../src/workers/scheduled-function.worker";

describe("scheduled-function cron parser (isDue)", () => {
  test("wildcard expression fires every minute", () => {
    const date = new Date("2026-06-15T10:30:00Z");
    expect(isDue("* * * * *", date)).toBe(true);
  });

  test("specific minute and hour matches", () => {
    const date = new Date("2026-06-15T10:30:00Z");
    // local timezone interpretation is fine; test a minute that exists
    expect(isDue("30 10 * * *", date)).toBe(true);
    expect(isDue("31 10 * * *", date)).toBe(false);
  });

  test("comma list matches", () => {
    const date = new Date("2026-06-15T10:15:00Z");
    expect(isDue("0,15,30,45 * * * *", date)).toBe(true);
  });

  test("step expression matches", () => {
    const date = new Date("2026-06-15T10:10:00Z");
    expect(isDue("*/10 * * * *", date)).toBe(true);
    const off = new Date("2026-06-15T10:07:00Z");
    expect(isDue("*/10 * * * *", off)).toBe(false);
  });

  test("range matches", () => {
    const inRange = new Date("2026-06-15T09:00:00Z");
    expect(isDue("0 0-10 * * *", inRange)).toBe(true);
    const outOfRange = new Date("2026-06-15T15:00:00Z");
    expect(isDue("0 0-10 * * *", outOfRange)).toBe(false);
  });

  test("day-of-week: 0 and 7 both mean Sunday", () => {
    // 2026-06-14 is a Sunday
    const sunday = new Date("2026-06-14T10:00:00Z");
    expect(isDue("0 10 * * 0", sunday)).toBe(true);
    expect(isDue("0 10 * * 7", sunday)).toBe(true);
    expect(isDue("0 10 * * 1", sunday)).toBe(false);
  });

  test("dom and dow OR semantics when both restricted", () => {
    // 2026-06-15 is a Monday (dow=1), dom=15
    const date = new Date("2026-06-15T10:00:00Z");
    // dom=15 matches even though dow=2 (Tuesday) doesn't
    expect(isDue("0 10 15 * 2", date)).toBe(true);
    // dom=99 won't match but dow=1 (Monday) does
    expect(isDue("0 10 99 * 1", date)).toBe(true);
    // neither matches
    expect(isDue("0 10 99 * 3", date)).toBe(false);
  });

  test("invalid expression returns false", () => {
    const date = new Date("2026-06-15T10:00:00Z");
    expect(isDue("not a cron", date)).toBe(false);
    expect(isDue("* * *", date)).toBe(false);
  });
});
