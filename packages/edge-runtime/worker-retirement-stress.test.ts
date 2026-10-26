import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const STRESS_TEST_TIMEOUT_MS = 15_000;

describe("WorkerPool process-level cooperative retirement", () => {
  test.each([
    { mode: "cooperative fetch timeout", args: [], retirements: 0 },
    { mode: "hard waitUntil timeout", args: ["--wait-until"], retirements: 24 },
  ])("survives $mode and serves subsequent requests", async ({ args, retirements }) => {
    const fixturePath = join(import.meta.dir, "worker-retirement-stress-fixture.ts");
    const child = Bun.spawn([process.execPath, fixturePath, ...args], {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    const reportLine = stdout.trim().split("\n").at(-1);
    expect(reportLine).toBeDefined();
    const report = JSON.parse(reportLine!);
    expect(report).toEqual({
      survived: true,
      retirements,
      naturalExits: retirements,
      retiredWorkers: 0,
      budgetExceeded: 0,
      idleWorkers: 2,
    });
  }, STRESS_TEST_TIMEOUT_MS);
});
