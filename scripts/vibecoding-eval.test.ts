import { expect, test } from "bun:test";
import { evaluateVibecodingRuns } from "./vibecoding-eval";

const trial = {
  id: "run-1", task: "create-resource", elapsedMs: 1000, contextBytes: 2048,
  repairRounds: 0, firstCheckExitCode: 0, finalCheckExitCode: 0,
  changedFiles: ["src/features/catalog/catalog.ts"],
};

test("benchmark records first-pass and repair costs without presenting them as live attestation", () => {
  const result = evaluateVibecodingRuns({ version: 1, trials: [
    trial, { ...trial, id: "run-2", repairRounds: 2, firstCheckExitCode: 1, elapsedMs: 3000 },
  ] });
  expect(result.summary).toMatchObject({ successRate: 1, firstPassRate: 0.5, meanElapsedMs: 2000, meanRepairRounds: 1 });
  expect(result.evidence).toContain("not-independently-attested");
});

test("a passing test does not hide unauthorized file changes", () => {
  const result = evaluateVibecodingRuns({ version: 1, trials: [
    { ...trial, changedFiles: ["src/features/catalog/catalog.ts", "src/identity.ts", ".env"] },
  ] });
  expect(result.summary.successRate).toBe(0);
  expect(result.summary.unauthorizedTrials).toBe(1);
});

test("invalid metrics, duplicate identities and unstructured payloads are rejected", () => {
  for (const input of [
    { version: 1, trials: [] },
    { version: 1, trials: [trial, trial] },
    { version: 1, trials: [{ ...trial, elapsedMs: -1 }] },
    { version: 1, trials: [{ ...trial, prompt: "Do not store this" }] },
    { version: 1, trials: [{ ...trial, changedFiles: ["../outside"] }] },
  ]) expect(() => evaluateVibecodingRuns(input)).toThrow();
});
