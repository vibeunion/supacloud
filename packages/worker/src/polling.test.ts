import { describe, expect, test } from "bun:test";
import { adaptivePollInterval } from "./polling.js";

describe("adaptive worker polling", () => {
  test("backs off on empty polls and resets immediately when work arrives", () => {
    const interval = adaptivePollInterval({ minIntervalMs: 20, maxIntervalMs: 100, idleBackoffFactor: 2 });
    expect(interval()).toBe(20);
    expect(interval(0)).toBe(40);
    expect(interval()).toBe(40);
    expect(interval(0)).toBe(80);
    expect(interval(0)).toBe(100);
    expect(interval(0)).toBe(100);
    expect(interval(2)).toBe(20);
    expect(interval()).toBe(20);
  });

  test("rejects unsafe polling bounds", () => {
    expect(() => adaptivePollInterval({ minIntervalMs: 0 })).toThrow("WORKER_POLLING_INVALID");
    expect(() => adaptivePollInterval({ minIntervalMs: 100, maxIntervalMs: 10 })).toThrow("WORKER_POLLING_INVALID");
    expect(() => adaptivePollInterval({ idleBackoffFactor: 5 })).toThrow("WORKER_POLLING_INVALID");
  });
});
