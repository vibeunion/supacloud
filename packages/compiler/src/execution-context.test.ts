import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExecutionContextPack, executionContextFromSnapshot, EXECUTION_CONTEXT_LIMITS, readExecutionMetadata } from "./execution-context";
import { createExecutionSnapshot, parseExecutionSnapshot, serializedExecutionSnapshot, EXECUTION_SNAPSHOT_MAX_BYTES } from "./execution-snapshot";
import type { ApplicationGraph, ModuleNode } from "./types";

const event = {
  kind: "command", operation: "review.approve", stage: "authorize",
  phase: "failed", requestId: "trace-one", durationMs: 0.2,
} as const;
const envelope = (events: unknown[] = [event]) => ({ version: 1, events });
const module = (name = "review"): ModuleNode => ({
  name, className: `${name}Module`, file: `src/${name}.ts`, line: 1, imports: [],
  providers: [], controllers: [], queries: [], exports: [],
  commands: [{ name: `${name}.approve`, className: "ApproveReview", transaction: "required", idempotency: "required" }],
});
const graph = (): ApplicationGraph => ({ modules: [module()], externalTokens: [] });

test("build snapshots deduplicate dependency neighborhoods and validate before publication", () => {
  const modules = Array.from({ length: 160 }, (_, index) => {
    const item = module(`business-feature-${index}`);
    item.imports = index ? [`business-feature-${index - 1}`] : [];
    return item;
  });
  const source: ApplicationGraph = { modules, externalTokens: [] };
  const serialized = serializedExecutionSnapshot(source);
  expect(Buffer.byteLength(serialized)).toBeLessThan(EXECUTION_SNAPSHOT_MAX_BYTES);
  expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(JSON.stringify(createExecutionSnapshot(source))) / 2);
  const snapshot = parseExecutionSnapshot(JSON.parse(serialized));
  const events = envelope([{ ...event, operation: "business-feature-0.approve" }]);
  expect(executionContextFromSnapshot(snapshot, "business-feature-0", events, "trace-one"))
    .toEqual(createExecutionContextPack(source, "business-feature-0", events, "trace-one"));
  const invalid = JSON.parse(serialized);
  invalid.contexts[0].files = [invalid.files.length];
  expect(() => parseExecutionSnapshot(invalid)).toThrow("Invalid execution snapshot reference");
  expect(() => serializedExecutionSnapshot({ ...graph(), diagnostics: [{
    severity: "warn", code: "x".repeat(EXECUTION_SNAPSHOT_MAX_BYTES), message: "not serialized",
  }] })).toThrow("Execution snapshot exceeds byte budget");
});

test("execution metadata joins current graph and diagnostics without exposing source expressions or repair values", () => {
  const source = graph();
  source.modules[0]!.tags = ["PRIVATE_SOURCE_VALUE"];
  source.diagnostics = [{
    severity: "error", code: "invalid-command-mode", file: "src/review.ts", line: 7,
    message: "PRIVATE_SOURCE_VALUE", suggestion: "PRIVATE_SOURCE_VALUE",
    fix: { type: "set_command_mode", targetFile: "src/review.ts", command: "ApproveReview",
      property: "transaction", expectedExpression: "PRIVATE_SOURCE_VALUE" },
  }];
  const pack = createExecutionContextPack(source, "ApproveReview", envelope([
    { ...event, requestId: "other-trace" }, event,
    { ...event, operation: "UNTRUSTED_OPERATION_SECRET" }, { ...event, stage: "UNTRUSTED_STAGE_SECRET" },
  ]), "trace-one");
  expect(pack.subject).toBe("review");
  expect(pack.events).toEqual([{ ...event, index: 1, module: "review" }]);
  expect(pack.omitted.unmatchedEvents).toBe(2);
  expect(pack.deploymentVerified).toBe(false);
  expect(pack.eventsTrusted).toBe(false);
  expect(pack.correlation).toBe("current-graph-only");
  expect(pack.diagnostics).toEqual([{
    severity: "error", code: "invalid-command-mode", file: "src/review.ts", line: 7,
    repair: { type: "set_command_mode", readiness: "input-required" },
  }]);
  for (const secret of ["PRIVATE_SOURCE_VALUE", "UNTRUSTED_OPERATION_SECRET", "UNTRUSTED_STAGE_SECRET", "other-trace"]) {
    expect(JSON.stringify(pack)).not.toContain(secret);
  }
  expect(Buffer.byteLength(JSON.stringify(pack, null, 2))).toBeLessThanOrEqual(EXECUTION_CONTEXT_LIMITS.outputBytes);
});

test("legacy command class names resolve to canonical graph operations without accepting ambiguity", () => {
  const source = graph();
  expect(createExecutionContextPack(source, "review", envelope([{ ...event, operation: "ApproveReview" }]), "trace-one")
    .events[0]?.operation).toBe("review.approve");
  source.modules.push(module("other"));
  expect(() => createExecutionContextPack(source, "review", envelope([{ ...event, operation: "ApproveReview" }]), "trace-one"))
    .toThrow("EXECUTION_CONTEXT_NOT_FOUND");
  expect(createExecutionContextPack(source, "review", envelope(), "trace-one").events).toHaveLength(1);
});

test("jobs and routes correlate only their declared operation and stage", () => {
  const source = graph();
  source.modules[0]!.jobs = [{ name: "review.verify", className: "VerifyJob", serviceKey: "verifyJob", scope: "job" }];
  source.modules[0]!.controllers = [{
    className: "ReviewController", deps: [], scope: "application", file: "src/review.ts",
    importPath: "src/review", path: "/reviews", routes: [{ method: "GET", path: "/:id", handler: "get" }],
  }];
  const pack = createExecutionContextPack(source, "review", envelope([
    { ...event, kind: "job", operation: "review.verify", stage: "handler" },
    { ...event, kind: "route", operation: "GET /reviews/:id", stage: "handler" },
    { ...event, kind: "route", operation: "GET /reviews/private-record", stage: "handler" },
  ]), "trace-one");
  expect(pack.events.map((entry) => entry.kind)).toEqual(["job", "route"]);
  expect(pack.omitted.unmatchedEvents).toBe(1);
  expect(JSON.stringify(pack)).not.toContain("private-record");
});

test("executor failures before authorization remain visible in the command plan", () => {
  const pack = createExecutionContextPack(graph(), "review", envelope([
    { ...event, stage: "commandExecutor" },
  ]), "trace-one");
  expect(pack.events[0]?.stage).toBe("commandExecutor");
  expect(pack.omitted.unmatchedEvents).toBe(0);
  expect(pack.executionPlans[0]?.stages).toContain("commandExecutor");
});

test("unsupported fields, malformed metadata and absent traces fail without echoing their contents", () => {
  for (const observations of [
    { ...envelope(), credentials: "PRIVATE_INPUT" },
    envelope([{ ...event, headers: { authorization: "PRIVATE_INPUT" } }]),
    envelope([{ ...event, error: "PRIVATE_INPUT" }]),
    envelope([{ ...event, durationMs: -1 }]),
    envelope([{ ...event, durationMs: Infinity }]),
    envelope([{ ...event, attempt: 0 }]),
    envelope([{ ...event, attempt: 1.5 }]),
    envelope([{ ...event, attempt: "1" }]),
    envelope([{ ...event, traceId: "bad id" }]),
    envelope([{ ...event, requestId: "PRIVATE_INPUT\n" }]),
    envelope([{ ...event, operation: "bad\nname" }]),
    envelope([{ ...event, kind: { toString: () => "command" } }]),
    envelope([{ ...event, phase: "unknown" }]),
    envelope(Array.from({ length: EXECUTION_CONTEXT_LIMITS.inputEvents + 1 }, () => event)),
  ]) {
    try {
      createExecutionContextPack(graph(), "review", observations, "trace-one");
      throw new Error("Expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe("EXECUTION_METADATA_INVALID");
      expect(String(error)).not.toContain("PRIVATE_INPUT");
    }
  }
  expect(() => createExecutionContextPack(graph(), "review", envelope(), "missing-trace"))
    .toThrow("EXECUTION_CONTEXT_NOT_FOUND");
});

test("bounded context preserves failures and reports truncation and unsafe source paths", () => {
  const source = graph();
  source.moduleHandlerFiles = { review: ["/private/secret.ts", "../secret.ts", "C:\\private\\secret.ts", "https://private.invalid/secret.ts"] };
  const events = Array.from({ length: 150 }, () => ({ ...event, phase: "succeeded" }));
  events.push(event);
  const pack = createExecutionContextPack(source, "review", envelope(events), "trace-one");
  expect(pack.events).toHaveLength(EXECUTION_CONTEXT_LIMITS.events);
  expect(pack.events.at(-1)?.phase).toBe("failed");
  expect(pack.events.at(-1)?.index).toBe(150);
  expect(pack.omitted.events).toBe(23);
  expect(pack.omitted.files).toBe(4);
  expect(JSON.stringify(pack)).not.toContain("secret.ts");
});

test("result byte budget is enforced even when graph metadata is unusually large", () => {
  const source = graph();
  source.modules[0]!.name = "x".repeat(EXECUTION_CONTEXT_LIMITS.outputBytes);
  expect(() => createExecutionContextPack(source, source.modules[0]!.name, envelope(), "trace-one"))
    .toThrow("EXECUTION_CONTEXT_TOO_LARGE");
});

test("programmatic input enforces UTF-8 bytes, not just event count or JavaScript string length", () => {
  const observations = envelope([event, ...Array.from({ length: 750 }, () => ({
    ...event, operation: "\u754c".repeat(512),
  }))]);
  const encoded = JSON.stringify(observations);
  expect(encoded.length).toBeLessThan(EXECUTION_CONTEXT_LIMITS.inputBytes);
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(EXECUTION_CONTEXT_LIMITS.inputBytes);
  expect(() => createExecutionContextPack(graph(), "review", observations, "trace-one"))
    .toThrow("EXECUTION_METADATA_INVALID");
});

test("file reader rejects malformed, oversized and non-file inputs without revealing content", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-context-read-"));
  try {
    const file = join(root, "events.json");
    await writeFile(file, JSON.stringify(envelope()));
    expect(await readExecutionMetadata(file)).toEqual(envelope());
    await writeFile(file, '{"authorization": "PRIVATE_INPUT"');
    await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
    const valid = JSON.stringify(envelope());
    const exactlyAtLimit = valid + " ".repeat(EXECUTION_CONTEXT_LIMITS.inputBytes - Buffer.byteLength(valid));
    await writeFile(file, exactlyAtLimit);
    expect(await readExecutionMetadata(file)).toEqual(envelope());
    await writeFile(file, exactlyAtLimit + "\n");
    await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
    const multibyte = JSON.stringify(envelope([event, ...Array.from({ length: 750 }, () => ({
      ...event, operation: "\u754c".repeat(512),
    }))]));
    expect(multibyte.length).toBeLessThan(EXECUTION_CONTEXT_LIMITS.inputBytes);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(EXECUTION_CONTEXT_LIMITS.inputBytes);
    await writeFile(file, multibyte);
    await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
    await expect(readExecutionMetadata(root)).rejects.toThrow("EXECUTION_METADATA_INVALID");
    await expect(readExecutionMetadata(join(root, "PRIVATE_INPUT"))).rejects.toThrow("EXECUTION_METADATA_UNREADABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const httpLog = (metadata: Record<string, unknown> = event) => ({
  event: "review-http-execution", component: "review-http",
  timestamp: "2026-10-16T05:14:01.000Z", ...metadata,
});

test("the actual generated HTTP logger feeds context without a hand-written conversion", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-log-generated-"));
  try {
    const template: { STARTER_EXECUTION_OBSERVABILITY: string } = await import(new URL(
      "../../cli/src/shared/tools/app-starter-execution-observability.ts", import.meta.url,
    ).href);
    const modulePath = join(root, "observer.ts");
    await writeFile(modulePath, template.STARTER_EXECUTION_OBSERVABILITY);
    const generated: { createReviewHttpObserver(): (metadata: typeof event) => void } =
      await import(pathToFileURL(modulePath).href);
    const lines: string[] = [];
    const log = spyOn(console, "info").mockImplementation((line: string) => { lines.push(line); });
    try { generated.createReviewHttpObserver()(event); }
    finally { log.mockRestore(); }
    expect(lines).toHaveLength(1);
    const file = join(root, "stdout.ndjson");
    await writeFile(file, lines.join("\n") + "\n");
    const observations = await readExecutionMetadata(file);
    expect(observations).toEqual(envelope());
    expect(createExecutionContextPack(graph(), "review", observations, "trace-one"))
      .toEqual(createExecutionContextPack(graph(), "review", envelope(), "trace-one"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("starter JSON-lines logs normalize to the existing untrusted execution context", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-log-context-"));
  try {
    const file = join(root, "execution.ndjson");
    const source = graph();
    source.modules[0]!.jobs = [{ name: "review.verify", className: "VerifyJob", serviceKey: "verifyJob", scope: "job" }];
    const job = { ...event, kind: "job" as const, operation: "review.verify", stage: "handler", requestId: "workflow-run-1" };
    const worker = { ...httpLog(job), event: "review-worker-execution", component: "review-attachment-worker", workerId: "worker-1" };
    await writeFile(file, [httpLog(), worker, httpLog({ ...event, requestId: "other-request" })]
      .map(log => JSON.stringify(log)).join("\r\n\n") + "\r\n");
    const observations = await readExecutionMetadata(file);
    expect(observations).toEqual(envelope([event, job, { ...event, requestId: "other-request" }]));
    const pack = createExecutionContextPack(source, "review", observations, "trace-one");
    expect(pack).toEqual(createExecutionContextPack(source, "review",
      envelope([event, job, { ...event, requestId: "other-request" }]), "trace-one"));
    expect(pack.events).toEqual([{ ...event, index: 0, module: "review" }]);
    expect(pack).toMatchObject({ deploymentVerified: false, eventsTrusted: false, correlation: "current-graph-only" });
    for (const excluded of ["timestamp", "component", "worker-1", "workflow-run-1", "other-request"]) {
      expect(JSON.stringify(pack)).not.toContain(excluded);
    }
    const workerPack = createExecutionContextPack(source, "review", observations, "workflow-run-1");
    expect(workerPack.events).toEqual([{ ...job, index: 1, module: "review" }]);
    expect(executionContextFromSnapshot(createExecutionSnapshot(source), "review", observations, "workflow-run-1"))
      .toEqual(workerPack);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single execution log records and legacy envelopes retain their supported formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-log-single-"));
  try {
    const file = join(root, "events.json");
    for (const content of [JSON.stringify(httpLog()), JSON.stringify(httpLog()) + "\n",
      JSON.stringify(httpLog(), null, 2), JSON.stringify(envelope(), null, 2)]) {
      await writeFile(file, content);
      expect(await readExecutionMetadata(file)).toEqual(envelope());
    }
    await writeFile(file, JSON.stringify(httpLog({ ...event, kind: "route", operation: "GET /reviews/:id", stage: "handler" })));
    expect(await readExecutionMetadata(file)).toEqual(envelope([
      { ...event, kind: "route", operation: "GET /reviews/:id", stage: "handler" },
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mixed, malformed and unsafe execution logs fail closed without exposing input", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-log-invalid-"));
  try {
    const file = join(root, "PRIVATE_PATH.ndjson");
    const invalidLogs: unknown[] = [
      { ...httpLog(), credentials: "PRIVATE_INPUT" },
      { ...httpLog(), input: { authorization: "PRIVATE_INPUT" } },
      { ...httpLog(), event: "PRIVATE_INPUT" },
      { ...httpLog(), component: "PRIVATE_INPUT" },
      { ...httpLog(), timestamp: "PRIVATE_INPUT" },
      { ...httpLog(), timestamp: "2026-02-30T00:00:00.000Z" },
      { ...httpLog(), timestamp: 123 },
      { ...httpLog(), timestamp: undefined },
      { ...httpLog(), workerId: "worker-1" },
      { ...httpLog(), kind: "job" },
      { ...httpLog(), event: "review-worker-execution", component: "review-attachment-worker" },
      { ...httpLog(), event: "review-worker-execution", component: "review-attachment-worker", kind: "job", workerId: "bad\nid" },
      httpLog({ ...event, requestId: "PRIVATE_INPUT\n" }),
      httpLog({ ...event, durationMs: -1 }),
      httpLog({ ...event, phase: "PRIVATE_INPUT" }),
      { version: 1, events: [event] },
      null,
      ["PRIVATE_INPUT"],
    ];
    const contents = invalidLogs.map(log => JSON.stringify(httpLog()) + "\n" + JSON.stringify(log));
    contents.push(JSON.stringify(httpLog()) + "\nPRIVATE_INPUT", '{"event":"PRIVATE_INPUT"', "\n \r\n");
    for (const content of contents) {
      await writeFile(file, content);
      await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
      try {
        await readExecutionMetadata(file);
        throw new Error("Expected rejection");
      } catch (error) {
        expect((error as Error).message).toBe("EXECUTION_METADATA_INVALID");
        expect(String(error)).not.toContain("PRIVATE_");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("execution log ingestion enforces the existing event and raw-byte limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-log-limits-"));
  try {
    const file = join(root, "events.ndjson");
    const line = JSON.stringify(httpLog());
    const content = Array.from({ length: EXECUTION_CONTEXT_LIMITS.inputEvents }, () => line).join("\n");
    await writeFile(file, content);
    expect(await readExecutionMetadata(file)).toEqual(envelope(
      Array.from({ length: EXECUTION_CONTEXT_LIMITS.inputEvents }, () => event)));
    await writeFile(file, content + "\n" + line);
    await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
    await writeFile(file, line + "\n".repeat(EXECUTION_CONTEXT_LIMITS.inputBytes));
    await expect(readExecutionMetadata(file)).rejects.toThrow("EXECUTION_METADATA_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("execution context builds an ordered per-attempt business timeline", () => {
  const pack = createExecutionContextPack(graph(), "review", envelope([
    { ...event, stage: "commandExecutor", phase: "succeeded", durationMs: 1 },
    { ...event, stage: "authorize", phase: "succeeded", durationMs: 2 },
    { ...event, stage: "idempotency", phase: "succeeded", durationMs: 3 },
    { ...event, stage: "transaction", phase: "started", durationMs: 4 },
    { ...event, stage: "transaction", phase: "failed", durationMs: 5, attempt: 1 },
    { ...event, stage: "commandExecutor", phase: "succeeded", durationMs: 1, attempt: 2, traceId: "trace-one" },
    { ...event, stage: "handler", phase: "succeeded", durationMs: 6, attempt: 2, traceId: "trace-one" },
  ]), "trace-one");
  expect(pack.timeline).toHaveLength(1);
  const entry = pack.timeline[0]!;
  expect(entry).toMatchObject({ kind: "command", operation: "review.approve", module: "review" });
  expect(entry.declaredStages).toContain("transaction");
  expect(entry.declaredStages).toContain("handler");
  expect(entry.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);

  const first = entry.attempts[0]!;
  expect(first.stages.map((stage) => stage.stage))
    .toEqual(["commandExecutor", "authorize", "idempotency", "transaction", "transaction"]);
  expect(first.failed).toBe(true);
  expect(first.complete).toBe(false);
  expect(first.missingStages).toEqual(["handler"]);
  expect(first.unexpectedStages).toEqual([]);

  const second = entry.attempts[1]!;
  expect(second.complete).toBe(true);
  expect(second.failed).toBe(false);
  expect(second.traceIds).toEqual(["trace-one"]);
  expect(second.missingStages).toEqual(["authorize", "idempotency", "transaction"]);
});

test("events without an attempt field remain a single first attempt", () => {
  const pack = createExecutionContextPack(graph(), "review", envelope([event]), "trace-one");
  expect(pack.timeline[0]!.attempts).toHaveLength(1);
  expect(pack.timeline[0]!.attempts[0]!.attempt).toBe(1);
  expect(pack.omitted.timeline).toBe(0);
});
