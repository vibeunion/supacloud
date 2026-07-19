import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("WorkerPool process-level cooperative retirement", () => {
  test("survives held fetch timeout churn and serves through replacements", async () => {
    const fixturePath = join(import.meta.dir, "worker-retirement-stress-fixture.ts");
    const child = Bun.spawn([process.execPath, fixturePath], {
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
      retirements: 24,
      naturalExits: 24,
      retiredWorkers: 0,
      budgetExceeded: 0,
      idleWorkers: 2,
    });
  });
});
