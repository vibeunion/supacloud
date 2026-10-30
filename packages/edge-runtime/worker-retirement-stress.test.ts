import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const STRESS_TEST_TIMEOUT_MS = 15_000;
const REPORT_PREFIX = "SUPACLOUD_RETIREMENT_REPORT ";

function readStressReport(stdout: string): unknown {
  const reportLine = stdout.split("\n").find((line) => line.startsWith(REPORT_PREFIX));
  if (reportLine === undefined) throw new Error("Worker retirement report is missing");
  return JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as unknown;
}

describe("WorkerPool process-level cooperative retirement", () => {
  test("reads the report when asynchronous trace spans follow it", () => {
    const report = { survived: true, retirements: 0 };
    const stdout = [
      "[Deno Compat] Loaded Deno API compatibility shim",
      `${REPORT_PREFIX}${JSON.stringify(report)}`,
      JSON.stringify({ schema: "supacloud.trace-span.v1", status: 200 }),
      "",
    ].join("\n");
    expect(readStressReport(stdout)).toEqual(report);
    expect(() => readStressReport("{\"schema\":\"supacloud.trace-span.v1\"}\n"))
      .toThrow("Worker retirement report is missing");
  });

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
    const report = readStressReport(stdout);
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
