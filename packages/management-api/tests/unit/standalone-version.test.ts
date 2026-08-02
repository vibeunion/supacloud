import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { isStandaloneVersionCommand } from "../../src/standalone";

const packageRoot = join(import.meta.dir, "../..");
const buildDirectory = mkdtempSync(join(tmpdir(), "supacloud-version-command-"));
const binaryPath = join(buildDirectory, "supacloud");

afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

async function captureProcess(command: string[], timeoutMs: number) {
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { exitCode, stdout, stderr, timedOut };
}

describe("standalone version command", () => {
  test("only intercepts the dedicated version invocation", () => {
    expect(isStandaloneVersionCommand(["--version"])).toBe(true);
    expect(isStandaloneVersionCommand(["-v"])).toBe(true);
    expect(isStandaloneVersionCommand(["upgrade", "--version", "0.51.0"])).toBe(false);
    expect(isStandaloneVersionCommand(["project", "--version"])).toBe(false);
  });

  test("compiled binary prints its version without loading runtime configuration", async () => {
    const build = await captureProcess([
      "bun",
      "build",
      "src/standalone.ts",
      "--compile",
      `--outfile=${binaryPath}`,
    ], 30_000);
    expect(build.timedOut).toBe(false);
    expect(build.exitCode).toBe(0);

    const version = await captureProcess([binaryPath, "--version"], 5_000);
    expect(version.timedOut).toBe(false);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain(`SupaCloud Version: ${pkg.version}`);
    expect(version.stderr).toBe("");
  }, 40_000);
});
