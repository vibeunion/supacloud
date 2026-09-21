import { describe, expect, test } from "bun:test";
import {
  createJobHarness,
  JobCancelledError,
  JobContractError,
  runJob,
} from "./job";

describe("Job test harness", () => {
  test("injects deterministic execution context and decodes both boundaries", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const seen: string[] = [];
    const result = await runJob({
      input: { value: "42" },
      jobId: "job-42",
      attempt: 3,
      now: () => now,
      inputDecoder: (value) => {
        const record = value as { value: string };
        return Number(record.value);
      },
      runner: (input, context) => {
        seen.push(`${context.jobId}:${context.attempt}:${input}:${context.now().toISOString()}`);
        expect(context.signal.aborted).toBe(false);
        return { value: input };
      },
      outputDecoder: (value) => ({
        value: (value as { value: number }).value,
        checked: true,
      }),
    });

    expect(result).toEqual({ value: 42, checked: true });
    expect(seen).toEqual(["job-42:3:42:2026-09-13T00:00:00.000Z"]);
  });

  test("wraps decoder failures without exposing values", async () => {
    const inputHarness = createJobHarness({
      input: { secret: "input-secret" },
      inputDecoder: () => { throw new Error("input-secret"); },
      runner: () => "unused",
    });
    await expect(inputHarness.promise).rejects.toBeInstanceOf(JobContractError);
    await expect(inputHarness.promise).rejects.toMatchObject({
      boundary: "input",
      code: "JOB_INPUT_VALIDATION_ERROR",
    });
    await expect(inputHarness.promise).rejects.not.toThrow("input-secret");

    const outputHarness = createJobHarness({
      input: null,
      runner: () => "output-secret",
      outputDecoder: () => { throw new Error("output-secret"); },
    });
    await expect(outputHarness.promise).rejects.toMatchObject({
      boundary: "output",
      code: "JOB_OUTPUT_VALIDATION_ERROR",
    });
  });

  test("cancels a pending runner through AbortSignal and a stable error", async () => {
    let observedAbort = false;
    const harness = createJobHarness({
      input: null,
      runner: (_input, context) => new Promise<never>((_, reject) => {
        context.signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new JobCancelledError());
        }, { once: true });
      }),
    });

    await Promise.resolve();
    harness.cancel();
    await expect(harness.promise).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    expect(harness.context.signal.aborted).toBe(true);
    expect(observedAbort).toBe(true);
  });

  test("rejects unsafe ids and invalid attempts before running", () => {
    expect(() => createJobHarness({
      input: null,
      jobId: "bad\njob",
      runner: () => undefined,
    })).toThrow("jobId");
    expect(() => createJobHarness({
      input: null,
      attempt: 0,
      runner: () => undefined,
    })).toThrow("attempt");
  });
});
