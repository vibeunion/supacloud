from pathlib import Path
import subprocess
p = Path('packages/compiler/src/execution-context.ts')
assert subprocess.check_output(['git', 'hash-object', str(p)], text=True).strip() == '50b3157f528d68e57d484623f06ef181649c4641'
s = p.read_text()
s = s.replace('  /** The last declared stage (or last observed stage) succeeded. Not a business-success claim. */', '  /** The last declared stage succeeded in the matched input, before display caps. Not business success. */')
s = s.replace('  traceIds: string[];\n}', '  traceIds: string[];\n  /** Matched stage observations excluded from this attempt\'s displayed details. */\n  omittedStages: number;\n}')
s = s.replace('  attempts: ExecutionTimelineAttempt[];\n}', '  attempts: ExecutionTimelineAttempt[];\n  /** Attempts excluded from this entry by the display cap. */\n  omittedAttempts: number;\n}')
s = s.replace('Ordered per-operation attempt timeline derived from the retained events and the static plan.', 'Per-operation timeline summarized from all matched observations, independently of display caps.')
s = s.replace('  byOperation: Map<string, ExecutionPlan[]>,\n): { timeline:', '  matchedPlans: ReadonlySet<ExecutionPlan>,\n): { timeline:')
s = s.replace('  const groups = new Map<string, { entry: ExecutionTimelineEntry; attempts: Map<number, AttemptAccumulator> }>();', '''  const operationKey = (kind: string, operation: string, module: string) => JSON.stringify([kind, operation, module]);
  const byOperation = new Map([...matchedPlans].map(plan => [operationKey(plan.kind, plan.name, plan.module), plan]));
  interface TimelineGroup { entry: ExecutionTimelineEntry; attempts: Map<number, AttemptAccumulator> }
  const groups = new Map<string, TimelineGroup>();''')
s = s.replace('    const key = JSON.stringify([event.kind, event.operation]);\n    let group', '    const key = operationKey(event.kind, event.operation, event.module);\n    let group')
s = s.replace('      const plan = (byOperation.get(key) ?? [])[0];', '      const plan = byOperation.get(key);')
s = s.replace('          attempts: [],\n', '          attempts: [],\n          omittedAttempts: 0,\n')
a = s.index('  const ordered = [...groups.values()]')
b = s.index('\n  return { timeline, omitted };', a)
s = s[:a] + '''  const hasFailure = (attempt: AttemptAccumulator) => attempt.stages.some(stage => stage.phase === "failed");
  const compareGroups = (left: TimelineGroup, right: TimelineGroup) =>
    left.entry.module.localeCompare(right.entry.module, "en")
    || left.entry.kind.localeCompare(right.entry.kind, "en")
    || left.entry.operation.localeCompare(right.entry.operation, "en");
  const ordered = [...groups.values()].sort((left, right) =>
    Number([...right.attempts.values()].some(hasFailure)) - Number([...left.attempts.values()].some(hasFailure))
    || compareGroups(left, right));
  const omitted = Math.max(0, ordered.length - EXECUTION_CONTEXT_LIMITS.timeline);
  const timeline = ordered.slice(0, EXECUTION_CONTEXT_LIMITS.timeline).sort(compareGroups).map((group): ExecutionTimelineEntry => {
    const declared = group.entry.declaredStages;
    const attempts = [...group.attempts.values()]
      .sort((left, right) => Number(hasFailure(right)) - Number(hasFailure(left)) || left.attempt - right.attempt)
      .slice(0, EXECUTION_CONTEXT_LIMITS.timelineAttempts)
      .sort((left, right) => left.attempt - right.attempt)
      .map((attempt): ExecutionTimelineAttempt => {
        const stages = [...attempt.stages]
          .sort((left, right) => Number(right.phase === "failed") - Number(left.phase === "failed") || left.index - right.index)
          .slice(0, EXECUTION_CONTEXT_LIMITS.timelineStages)
          .sort((left, right) => left.index - right.index);
        const terminal = declared[declared.length - 1];
        return {
          attempt: attempt.attempt,
          stages,
          failed: hasFailure(attempt),
          complete: terminal !== undefined
            && attempt.stages.some((stage) => stage.stage === terminal && stage.phase === "succeeded"),
          missingStages: declared.filter((stage) => !attempt.observed.has(stage)),
          // Unknown stages were counted, not echoed, at the correlation boundary.
          unexpectedStages: [],
          traceIds: [...attempt.traceIds].sort(),
          omittedStages: attempt.stages.length - stages.length,
        };
      });
    return { ...group.entry, attempts, omittedAttempts: group.attempts.size - attempts.length };
  });''' + s[b:]
s = s.replace('buildTimeline(retained, byOperation)', 'buildTimeline(matches, matchedPlans)')
p.write_text(s)
p = Path('packages/compiler/src/index.ts')
p.write_text(p.read_text().replace('export type { ExecutionContextPack } from "./execution-context";', 'export type { ExecutionContextPack, ExecutionTimelineStage, ExecutionTimelineAttempt, ExecutionTimelineEntry } from "./execution-context";'))
p = Path('docs/execution-context.md')
s = p.read_text().replace('observed stages outside the current static plan\n(`unexpectedStages`) and the `traceIds` seen.', '`traceIds` seen and the number of omitted details (`omittedStages`). Unknown\nstages are excluded before projection and counted in `omitted.unmatchedEvents`,\nnever echoed in `unexpectedStages` (which remains empty).')
s = s.replace('- **Attempts are caller-reported.**', '- **Summaries precede display caps.** Failure, terminal-stage success, missing\n  stages and trace IDs use all matched observations, not only displayed events.\n  Failed operations, attempts and stage observations take display priority; the\n  retained details preserve input order. `omitted.timeline` counts omitted\n  operation groups, each entry reports `omittedAttempts`, and each retained\n  attempt reports `omittedStages`. These counts are independent of the flat\n  `omitted.events` count.\n- **Attempts are caller-reported.**')
s = s.replace('the `index` field. Truncation counts are explicit, including `omitted.timeline`.', 'the `index` field. All three timeline caps report their omissions explicitly.')
p.write_text(s)
Path('packages/compiler/src/execution-timeline-regressions.test.ts').write_text('''import { expect, test } from "bun:test";
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
''')
