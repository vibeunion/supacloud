import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
