import { expect, test } from "bun:test";
import { createExecutionContextPack, EXECUTION_CONTEXT_LIMITS } from "./execution-context";
import type { ApplicationGraph, ModuleNode } from "./types";

const module = (name = "review"): ModuleNode => ({
  name, className: `${name}Module`, file: `src/${name}.ts`, line: 1, imports: [],
  providers: [], controllers: [], queries: [], exports: [],
  commands: [{ name: `${name}.approve`, className: "ApproveReview", transaction: "required", idempotency: "required" }],
});
const graph = (): ApplicationGraph => ({ modules: [module()], externalTokens: [] });
const event = { kind: "command", operation: "review.approve", stage: "authorize", phase: "succeeded", requestId: "r1" } as const;
const pack = (events: unknown[], source = graph()) => createExecutionContextPack(source, "review", { version: 1, events }, "r1");

test("timeline keeps late failures and reports omitted stage details", () => {
  const result = pack([
    ...Array.from({ length: 40 }, () => ({ ...event })),
    { ...event, stage: "transaction", phase: "failed" },
  ]);
  const attempt = result.timeline[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ failed: true, complete: false, omittedStages: 9 });
  expect(attempt.stages).toHaveLength(EXECUTION_CONTEXT_LIMITS.timelineStages);
  expect(attempt.stages.some(stage => stage.phase === "failed")).toBe(true);
  expect(attempt.stages.map(stage => stage.index)).toEqual(attempt.stages.map(stage => stage.index).sort((a, b) => a - b));
});

test("timeline summaries use all correlated observations, not the flat event cap", () => {
  const result = pack([
    ...Array.from({ length: 128 }, () => ({ ...event })),
    { ...event, stage: "handler", traceId: "trace-terminal" },
  ]);
  expect(result.events).toHaveLength(EXECUTION_CONTEXT_LIMITS.events);
  expect(result.omitted.events).toBe(1);
  const attempt = result.timeline[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ failed: false, complete: true, omittedStages: 97 });
  expect(attempt.missingStages).not.toContain("handler");
  expect(attempt.traceIds).toEqual(["trace-terminal"]);
});

test("attempt caps retain a late failure and explicitly count omitted attempts", () => {
  const result = pack(Array.from({ length: 17 }, (_, index) => ({
    ...event, attempt: index + 1, phase: index === 16 ? "failed" : "succeeded",
  })));
  expect(result.timeline[0]).toMatchObject({ omittedAttempts: 1 });
  const attempts = result.timeline[0]!.attempts;
  expect(attempts).toHaveLength(EXECUTION_CONTEXT_LIMITS.timelineAttempts);
  expect(attempts.some(attempt => attempt.attempt === 17 && attempt.failed)).toBe(true);
  expect(attempts.map(attempt => attempt.attempt)).toEqual(attempts.map(attempt => attempt.attempt).sort((a, b) => a - b));
});

test("canonical names colliding with another command alias cannot select the wrong plan", () => {
  const other = module("other");
  other.commands = [{ className: "review.approve", name: "other.action", transaction: "none", idempotency: "none", audit: "other.audit" }];
  const source = graph();
  source.modules.unshift(other);
  const result = pack([{ ...event, operation: "ApproveReview", stage: "handler" }], source);
  expect(result.timeline[0]).toMatchObject({ module: "review", operation: "review.approve" });
  expect(result.timeline[0]!.declaredStages).toContain("transaction");
  expect(result.timeline[0]!.declaredStages).not.toContain("audit");
  expect(result.timeline[0]!.attempts[0]!.complete).toBe(true);
});

test("untrusted unknown stages and other requests are never echoed by the timeline", () => {
  const result = pack([
    event,
    { ...event, stage: "PRIVATE_STAGE", traceId: "PRIVATE_TRACE" },
    { ...event, requestId: "other", traceId: "OTHER_TRACE" },
  ]);
  expect(result.omitted.unmatchedEvents).toBe(1);
  for (const value of ["PRIVATE_STAGE", "PRIVATE_TRACE", "OTHER_TRACE"]) expect(JSON.stringify(result)).not.toContain(value);
  expect(result.timeline[0]!.attempts[0]!.unexpectedStages).toEqual([]);
});
