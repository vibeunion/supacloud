import { expect, test } from "bun:test";
import { executionTrace, observeExecution, type ExecutionEvent } from "./execution";

test("execution telemetry omits absent metadata and keeps observer failures isolated", async () => {
  const events: Readonly<ExecutionEvent>[] = [];
  const result = await observeExecution((event) => {
    events.push(event);
    throw new Error("observer unavailable");
  }, { kind: "command", operation: "case.create", stage: "handler", ...executionTrace({}) }, () => 42);
  expect(result).toBe(42);
  expect(events).toHaveLength(2);
  expect(events[0]).toEqual({ kind: "command", operation: "case.create", stage: "handler", phase: "started" });
  expect(events[1]).toMatchObject({ phase: "succeeded", durationMs: expect.any(Number) });
  expect(Object.isFrozen(events[0])).toBe(true);
});

test("execution trace accepts only validated request IDs", () => {
  expect(executionTrace({ requestId: "request-1" })).toEqual({ requestId: "request-1" });
  for (const context of [null, {}, { requestId: 1 }, { requestId: "\ninvalid" }]) {
    expect(executionTrace(context)).toEqual({});
  }
});
