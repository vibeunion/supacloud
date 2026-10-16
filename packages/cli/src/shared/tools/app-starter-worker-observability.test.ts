import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { ExecutionObserver } from "@supacloud/elysia";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appStarterFiles } from "./app-starter";

const { observeExecution }: {
  observeExecution<T>(
    observer: ExecutionObserver,
    event: Pick<Parameters<ExecutionObserver>[0], "kind" | "operation" | "stage" | "requestId">,
    next: () => T | Promise<T>,
  ): Promise<T>;
} = await import(new URL("../../../../app/src/execution_observer.ts", import.meta.url).href);

let root: string;
let createObserver: (workerId: string) => ExecutionObserver;
const execution = { kind: "job", operation: "review.verify-attachment", stage: "handler", requestId: "run-123" } as const;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "starter-worker-observability-"));
  const file = join(root, "review-worker-observability.ts");
  await writeFile(file, appStarterFiles("worker-reference")["src/host/review-worker-observability.ts"]!);
  const generated: { createReviewWorkerObserver: typeof createObserver } = await import(pathToFileURL(file).href);
  createObserver = generated.createReviewWorkerObserver;
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("the generated delivery host connects worker execution to the emitted observer", () => {
  const files = appStarterFiles("worker-reference");
  expect(files["src/delivery-worker.ts"]).toContain('from "./host/review-worker-observability"');
  expect(files["src/delivery-worker.ts"]).toContain("onExecution: createReviewWorkerObserver(settings.workerId)");
  expect(files["src/host/review-attachment-worker.ts"]).toContain("onExecution: options.onExecution");
  expect(files["src/host/review-attachment-worker.ts"]).toContain("requestId: claim.runId");
});

test("worker logs carry only selected execution metadata and original correlation", async () => {
  const lines: string[] = [];
  const log = spyOn(console, "info").mockImplementation((line: string) => { lines.push(line); });
  try {
    const metadata = {
      ...execution, phase: "succeeded" as const, durationMs: 12.5,
      input: { token: "private-token" }, output: { objectPath: "private-path" },
      error: new Error("private-error"), credentials: "private-key", databaseParameters: ["private-row"],
    };
    await createObserver("worker-123")(metadata);
    expect(lines).toHaveLength(1);
    const record: Record<string, unknown> = JSON.parse(lines[0]!);
    expect(record).toEqual({
      event: "review-worker-execution", component: "review-attachment-worker",
      timestamp: expect.any(String), workerId: "worker-123",
      ...execution, phase: "succeeded", durationMs: 12.5,
    });
    expect(Number.isFinite(Date.parse(String(record["timestamp"])))).toBe(true);
    expect(lines[0]).not.toContain("private-");
  } finally { log.mockRestore(); }
});

test("malformed correlation identifiers and invalid durations are omitted", async () => {
  const lines: string[] = [];
  const log = spyOn(console, "info").mockImplementation((line: string) => { lines.push(line); });
  try {
    for (const requestId of ["", "x".repeat(257), "line\nbreak", "Bearer secret"]) {
      for (const durationMs of [-1, NaN, Infinity]) {
        await createObserver("worker\ninvalid")({ ...execution, phase: "failed", requestId, durationMs });
      }
    }
    expect(lines).toHaveLength(12);
    for (const line of lines) {
      const record: Record<string, unknown> = JSON.parse(line);
      expect(record).not.toHaveProperty("requestId");
      expect(record).not.toHaveProperty("workerId");
      expect(record).not.toHaveProperty("durationMs");
      expect(record["phase"]).toBe("failed");
    }
    await createObserver("worker.1:attachment")({ ...execution, phase: "succeeded", durationMs: 0 });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ workerId: "worker.1:attachment", requestId: "run-123", durationMs: 0 });
  } finally { log.mockRestore(); }
});

test("real execution dispatch logs start and terminal phase without changing the result", async () => {
  const lines: string[] = [];
  const log = spyOn(console, "info").mockImplementation((line: string) => { lines.push(line); });
  try {
    const result = { privateResult: "not-loggable" };
    const observer = createObserver("worker-123");
    expect(await observeExecution(observer, execution, () => result)).toBe(result);
    const failure = new Error("private-failure");
    await expect(observeExecution(observer, execution, () => { throw failure; })).rejects.toBe(failure);
    expect(lines.map(line => JSON.parse(line).phase)).toEqual(["started", "succeeded", "started", "failed"]);
    expect(lines.join("")).not.toContain("private");
    expect(lines.join("")).not.toContain("not-loggable");
  } finally { log.mockRestore(); }
});

test("a failed log sink neither changes the business outcome nor replays execution", async () => {
  const log = spyOn(console, "info").mockImplementation(() => { throw new Error("sink unavailable"); });
  try {
    let attempts = 0;
    const observer = createObserver("worker-123");
    expect(await observeExecution(observer, execution, () => { attempts++; return "committed"; })).toBe("committed");
    const failure = new Error("original failure");
    await expect(observeExecution(observer, execution, () => { attempts++; throw failure; })).rejects.toBe(failure);
    expect(attempts).toBe(2);
    expect(log).toHaveBeenCalledTimes(4);
  } finally { log.mockRestore(); }
});
