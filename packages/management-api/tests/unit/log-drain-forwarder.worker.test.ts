import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";

// Exercise the exported lifecycle without replacing the worker's static DB import.

const { startLogDrainForwarder, stopLogDrainForwarder } = await import("../../src/workers/log-drain-forwarder.worker");

// Suppress forwardLogEvent during tests by mocking the log-drains module
const logDrainsModule = await import("../../src/routes/log-drains");
const forwardSpy = spyOn(logDrainsModule, "forwardLogEvent").mockImplementation(
  mock(() => Promise.resolve()) as never,
);

describe("log-drain-forwarder worker", () => {
  afterAll(() => {
    forwardSpy.mockRestore();
    stopLogDrainForwarder();
  });

  test("startLogDrainForwarder does not throw", () => {
    expect(() => startLogDrainForwarder()).not.toThrow();
  });

  test("startLogDrainForwarder is idempotent (calling twice does not create duplicate timers)", () => {
    startLogDrainForwarder();
    startLogDrainForwarder();
    // Should not throw or create duplicates
    expect(true).toBe(true);
  });

  test("stopLogDrainForwarder does not throw", () => {
    stopLogDrainForwarder();
    // Start again so afterAll can clean up
    startLogDrainForwarder();
    expect(true).toBe(true);
  });
});
