import { expect, test } from "bun:test";
import { runCompilerBenchmark } from "./benchmark";

test("compiler benchmark reports measured generation paths and unchanged incremental ownership", async () => {
  const report = await runCompilerBenchmark();
  expect(report.fixtureFiles).toBe(14);
  expect(report.generatedBytes).toBeGreaterThan(0);
  expect(report.reusedModules).toEqual(["audit", "health"]);
  expect(report.reanalyzedModules).toEqual(["case"]);
  expect(report.generation).toMatchObject({ iterationsPerSample: 25, samples: 7 });
  for (const elapsed of [
    report.coldCompileMs,
    report.incrementalCompileMs,
    report.dependencyInvalidationMs,
    report.generation.legacyMedianMs,
    report.generation.reusedRenderMedianMs,
  ]) {
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThan(0);
  }
});
