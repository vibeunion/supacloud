import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { ExecutionPlan } from "./inspect";
import { createExecutionSnapshot, executionSourceFile as sourceFile, type ExecutionSnapshot } from "./execution-snapshot";
import type { ApplicationGraph } from "./types";

export const EXECUTION_CONTEXT_LIMITS: {
  readonly inputBytes: number;
  readonly inputEvents: number;
  readonly outputBytes: number;
  readonly events: number;
  readonly modules: number;
  readonly files: number;
  readonly diagnostics: number;
  readonly plans: number;
  readonly timeline: number;
  readonly timelineAttempts: number;
  readonly timelineStages: number;
} = Object.freeze({
  inputBytes: 1_048_576, inputEvents: 2048, outputBytes: 65_536,
  events: 128, modules: 16, files: 64, diagnostics: 32, plans: 64,
  timeline: 64, timelineAttempts: 16, timelineStages: 32,
});

interface ExecutionMetadata {
  kind: "route" | "command" | "job";
  operation: string;
  stage: string;
  phase: "started" | "succeeded" | "failed";
  requestId?: string;
  durationMs?: number;
  /** 1-based execution attempt; omitted means the first. Distinguishes retries without inventing a counter. */
  attempt?: number;
  /** Opaque correlation ID (for example a W3C trace ID) shared across a business operation and its tasks. */
  traceId?: string;
}

export interface ExecutionTimelineStage {
  stage: string;
  phase: "started" | "succeeded" | "failed";
  durationMs?: number;
  index: number;
}

export interface ExecutionTimelineAttempt {
  attempt: number;
  stages: ExecutionTimelineStage[];
  failed: boolean;
  /** The last declared stage (or last observed stage) succeeded. Not a business-success claim. */
  complete: boolean;
  /** Declared stages with no observation in this attempt. Absence is not proof a stage was skipped. */
  missingStages: string[];
  /** Observed stages not present in the current static plan. */
  unexpectedStages: string[];
  traceIds: string[];
}

export interface ExecutionTimelineEntry {
  kind: "route" | "command" | "job";
  operation: string;
  module: string;
  declaredStages: string[];
  attempts: ExecutionTimelineAttempt[];
}

export class ExecutionContextError extends Error {
  constructor(readonly code: "EXECUTION_METADATA_INVALID" | "EXECUTION_METADATA_UNREADABLE"
    | "EXECUTION_CONTEXT_NOT_FOUND" | "EXECUTION_CONTEXT_TOO_LARGE") {
    super(code);
    this.name = "ExecutionContextError";
  }
}

export interface ExecutionContextPack {
  version: 1;
  subject: string;
  requestId: string;
  correlation: "current-graph-only";
  deploymentVerified: false;
  eventsTrusted: false;
  modules: Array<{ name: string; file?: string }>;
  files: string[];
  executionPlans: ExecutionPlan[];
  events: Array<ExecutionMetadata & { index: number; module: string }>;
  diagnostics: Array<{
    code: string; severity: "error" | "warn"; file?: string; line?: number;
    repair?: { type: string; readiness: "preview" | "input-required" | "manual" };
  }>;
  omitted: {
    events: number; modules: number; files: number; diagnostics: number; plans: number; unmatchedEvents: number;
    timeline: number;
  };
  /** Ordered per-operation attempt timeline derived from the retained events and the static plan. */
  timeline: ExecutionTimelineEntry[];
  limits: typeof EXECUTION_CONTEXT_LIMITS;
}

function invalid(): never {
  throw new ExecutionContextError("EXECUTION_METADATA_INVALID");
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}

function metadataText(input: unknown, maxLength: number): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(input);
}

function requestIdentifier(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(input);
}

function decodeMetadata(input: unknown): ExecutionMetadata[] {
  const envelope = record(input);
  if (Object.keys(envelope).some((key) => key !== "version" && key !== "events")
    || envelope.version !== 1 || !Array.isArray(envelope.events)
    || envelope.events.length > EXECUTION_CONTEXT_LIMITS.inputEvents) return invalid();
  const events = envelope.events.map((entry: unknown): ExecutionMetadata => {
    const event = record(entry);
    if (Object.keys(event).some((key) =>
      !["kind", "operation", "stage", "phase", "requestId", "durationMs", "attempt", "traceId"].includes(key))
      || (event.kind !== "route" && event.kind !== "command" && event.kind !== "job")
      || (event.phase !== "started" && event.phase !== "succeeded" && event.phase !== "failed")
      || !metadataText(event.operation, 512) || !metadataText(event.stage, 256)
      || ("requestId" in event && !requestIdentifier(event.requestId))
      || ("traceId" in event && !requestIdentifier(event.traceId))
      || ("attempt" in event && (typeof event.attempt !== "number" || !Number.isInteger(event.attempt)
        || event.attempt < 1 || event.attempt > 1_000_000))
      || ("durationMs" in event && (typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs)
        || event.durationMs < 0 || event.durationMs > Number.MAX_SAFE_INTEGER))) return invalid();
    return {
      kind: event.kind,
      operation: event.operation, stage: event.stage, phase: event.phase,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId as string }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs as number }),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt as number }),
      ...(event.traceId === undefined ? {} : { traceId: event.traceId as string }),
    };
  });
  if (Buffer.byteLength(JSON.stringify({ version: 1, events }), "utf8") > EXECUTION_CONTEXT_LIMITS.inputBytes) return invalid();
  return events;
}

/** Read only a bounded regular file; parse failures never echo file contents or paths. */
export async function readExecutionMetadata(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > EXECUTION_CONTEXT_LIMITS.inputBytes) return invalid();
      const buffer = Buffer.alloc(EXECUTION_CONTEXT_LIMITS.inputBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > EXECUTION_CONTEXT_LIMITS.inputBytes) return invalid();
      try { return JSON.parse(buffer.subarray(0, offset).toString("utf8")); }
      catch { return invalid(); }
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ExecutionContextError) throw error;
    throw new ExecutionContextError("EXECUTION_METADATA_UNREADABLE");
  }
}

/** Structural correlation only. Observations are untrusted hints, not audit or deployment receipts. */
export function createExecutionContextPack(
  graph: ApplicationGraph,
  subject: string,
  observations: unknown,
  requestId: string,
): ExecutionContextPack {
  if (!requestIdentifier(requestId)) return invalid();
  const events = decodeMetadata(observations);
  return correlateSnapshot(createExecutionSnapshot(graph, [subject]), subject, events, requestId);
}

export function executionContextFromSnapshot(
  snapshot: ExecutionSnapshot, subject: string, observations: unknown, requestId: string,
): ExecutionContextPack {
  if (!requestIdentifier(requestId)) return invalid();
  const events = decodeMetadata(observations);
  return correlateSnapshot(snapshot, subject, events, requestId);
}

function buildTimeline(
  events: Array<ExecutionMetadata & { index: number; module: string }>,
  byOperation: Map<string, ExecutionPlan[]>,
): { timeline: ExecutionTimelineEntry[]; omitted: number } {
  interface AttemptAccumulator {
    attempt: number;
    stages: ExecutionTimelineStage[];
    observed: Set<string>;
    traceIds: Set<string>;
  }
  const groups = new Map<string, { entry: ExecutionTimelineEntry; attempts: Map<number, AttemptAccumulator> }>();
  for (const event of events) {
    const key = JSON.stringify([event.kind, event.operation]);
    let group = groups.get(key);
    if (!group) {
      const plan = (byOperation.get(key) ?? [])[0];
      group = {
        entry: {
          kind: event.kind,
          operation: event.operation,
          module: event.module,
          declaredStages: plan ? [...plan.stages] : [],
          attempts: [],
        },
        attempts: new Map(),
      };
      groups.set(key, group);
    }
    const attemptNumber = event.attempt ?? 1;
    let attempt = group.attempts.get(attemptNumber);
    if (!attempt) {
      attempt = { attempt: attemptNumber, stages: [], observed: new Set(), traceIds: new Set() };
      group.attempts.set(attemptNumber, attempt);
    }
    attempt.stages.push({
      stage: event.stage,
      phase: event.phase,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      index: event.index,
    });
    attempt.observed.add(event.stage);
    if (event.traceId) attempt.traceIds.add(event.traceId);
  }

  const ordered = [...groups.values()].sort((left, right) =>
    left.entry.module.localeCompare(right.entry.module, "en")
    || left.entry.kind.localeCompare(right.entry.kind, "en")
    || left.entry.operation.localeCompare(right.entry.operation, "en"));
  const omitted = Math.max(0, ordered.length - EXECUTION_CONTEXT_LIMITS.timeline);
  const timeline = ordered.slice(0, EXECUTION_CONTEXT_LIMITS.timeline).map((group): ExecutionTimelineEntry => {
    const declared = group.entry.declaredStages;
    const attempts = [...group.attempts.values()]
      .sort((left, right) => left.attempt - right.attempt)
      .slice(0, EXECUTION_CONTEXT_LIMITS.timelineAttempts)
      .map((attempt): ExecutionTimelineAttempt => {
        const stages = [...attempt.stages]
          .sort((left, right) => left.index - right.index)
          .slice(0, EXECUTION_CONTEXT_LIMITS.timelineStages);
        const terminal = declared.length > 0 ? declared[declared.length - 1] : stages[stages.length - 1]?.stage;
        return {
          attempt: attempt.attempt,
          stages,
          failed: stages.some((stage) => stage.phase === "failed"),
          complete: terminal !== undefined
            && stages.some((stage) => stage.stage === terminal && stage.phase === "succeeded"),
          missingStages: declared.filter((stage) => !attempt.observed.has(stage)),
          unexpectedStages: [...attempt.observed].filter((stage) => !declared.includes(stage)),
          traceIds: [...attempt.traceIds].sort(),
        };
      });
    return { ...group.entry, attempts };
  });
  return { timeline, omitted };
}

function correlateSnapshot(
  snapshot: ExecutionSnapshot, subject: string, events: ExecutionMetadata[], requestId: string,
): ExecutionContextPack {
  const exact = snapshot.contexts.find(context => context.subject === subject);
  const candidates = exact ? [exact] : snapshot.contexts.filter(context => context.aliases.includes(subject));
  if (candidates.length !== 1) throw new ExecutionContextError("EXECUTION_CONTEXT_NOT_FOUND");
  const context = candidates[0]!;
  const selected = new Set(context.modules.map((module) => module.name));
  const plans = snapshot.plans;
  const byOperation = new Map<string, ExecutionPlan[]>();
  const indexPlan = (plan: ExecutionPlan, operation = plan.name) => {
    const key = JSON.stringify([plan.kind, operation]);
    const matches = byOperation.get(key) ?? [];
    if (!matches.includes(plan)) matches.push(plan);
    byOperation.set(key, matches);
  };
  for (const plan of plans) {
    indexPlan(plan);
    if (plan.kind === "command") {
      const command = snapshot.commandAliases.find(command => command.module === plan.module && command.name === plan.name);
      if (command) indexPlan(plan, command.alias);
    }
  }
  const matches: ExecutionContextPack["events"] = [];
  const matchedPlans = new Set<ExecutionPlan>();
  let unmatchedEvents = 0;
  events.forEach((event, index) => {
    if (event.requestId !== requestId) return;
    const candidates = byOperation.get(JSON.stringify([event.kind, event.operation])) ?? [];
    const plan = candidates.length === 1 ? candidates[0] : undefined;
    if (!plan || !selected.has(plan.module) || !plan.stages.includes(event.stage)) {
      unmatchedEvents++;
      return;
    }
    matches.push({ ...event, operation: plan.name, index, module: plan.module });
    matchedPlans.add(plan);
  });
  if (matches.length === 0) throw new ExecutionContextError("EXECUTION_CONTEXT_NOT_FOUND");

  // Retain failures first without inventing a root cause or discarding input order.
  const retained = [...matches].sort((left, right) =>
    Number(right.phase === "failed") - Number(left.phase === "failed") || left.index - right.index)
    .slice(0, EXECUTION_CONTEXT_LIMITS.events).sort((left, right) => left.index - right.index);
  const timelineResult = buildTimeline(retained, byOperation);
  const modules = [...context.modules].sort((left, right) =>
    Number(right.name === context.subject) - Number(left.name === context.subject) || left.name.localeCompare(right.name));
  const files = context.files.flatMap((file) => sourceFile(file) ?? []);
  const diagnostics = context.diagnostics;
  const pack: ExecutionContextPack = {
    version: 1, subject: context.subject, requestId, correlation: "current-graph-only",
    deploymentVerified: false, eventsTrusted: false,
    modules: modules.slice(0, EXECUTION_CONTEXT_LIMITS.modules).map((module) => ({
      name: module.name, ...(sourceFile(module.file) ? { file: sourceFile(module.file) } : {}),
    })),
    files: files.slice(0, EXECUTION_CONTEXT_LIMITS.files),
    executionPlans: [...matchedPlans].slice(0, EXECUTION_CONTEXT_LIMITS.plans),
    events: retained, diagnostics: diagnostics.slice(0, EXECUTION_CONTEXT_LIMITS.diagnostics),
    timeline: timelineResult.timeline,
    omitted: {
      events: matches.length - retained.length,
      modules: Math.max(0, modules.length - EXECUTION_CONTEXT_LIMITS.modules),
      files: context.files.length - Math.min(files.length, EXECUTION_CONTEXT_LIMITS.files),
      diagnostics: Math.max(0, diagnostics.length - EXECUTION_CONTEXT_LIMITS.diagnostics),
      plans: Math.max(0, matchedPlans.size - EXECUTION_CONTEXT_LIMITS.plans), unmatchedEvents,
      timeline: timelineResult.omitted,
    },
    limits: EXECUTION_CONTEXT_LIMITS,
  };
  if (Buffer.byteLength(JSON.stringify(pack, null, 2), "utf8") + 1 > EXECUTION_CONTEXT_LIMITS.outputBytes) {
    throw new ExecutionContextError("EXECUTION_CONTEXT_TOO_LARGE");
  }
  return pack;
}
