import { describe, expect, test } from "bun:test";
import { copyFile, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function runController(operation: "activate" | "stop", environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-gotrue-controller-"));
  try {
    const systemctl = join(directory, "systemctl");
    const log = join(directory, "commands.log");
    await copyFile(join(import.meta.dir, "../fixtures/gotrue-controller-systemctl.sh"), systemctl);
    await chmod(systemctl, 0o700);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../fixtures/gotrue-controller-runner.ts"), operation], {
      env: { ...process.env, ...environment, PATH: directory, TEST_SYSTEMCTL_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    const commands = await Bun.file(log).exists() ? (await readFile(log, "utf8")).trim().split("\n") : [];
    return { exitCode, stdout, stderr, commands };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("GoTrue native process boundary", () => {
  test("runs the real controller shell path with exact project-scoped arguments", async () => {
    const result = await runController("activate");
    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([
      "enable supacloud-gotrue@project-a",
      "start supacloud-gotrue@project-a",
      "restart supacloud-gotrue@project-a",
    ]);
  });

  test("never invokes systemctl for external or malformed policy", async () => {
    for (const mode of ["external", "invalid"]) {
      const result = await runController("activate", { TEST_AUTH_MODE: mode });
      expect(result.exitCode).toBe(1);
      expect(result.commands).toEqual([]);
    }
  });

  test("does not start or restart after the policy changes following enable", async () => {
    const result = await runController("activate", { TEST_AUTH_MODE: "transition" });
    expect(result.exitCode).toBe(1);
    expect(result.commands).toEqual(["enable supacloud-gotrue@project-a"]);
  });

  test("a failed command stops activation without replay", async () => {
    const result = await runController("activate", { TEST_SYSTEMCTL_DENY: "start" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("systemctl start supacloud-gotrue@project-a failed: permission denied");
    expect(result.commands).toEqual(["enable supacloud-gotrue@project-a", "start supacloud-gotrue@project-a"]);
  });

  test("shutdown distinguishes absent units from denied observation and stop", async () => {
    const absent = await runController("stop", { TEST_SYSTEMCTL_STATE: "not-found" });
    expect(absent.exitCode).toBe(0);
    expect(absent.commands).toEqual([
      "show --property=LoadState --value supacloud-gotrue@project-a",
      "show --property=ActiveState --value supacloud-gotrue@project-a",
    ]);
    const observationDenied = await runController("stop", { TEST_SYSTEMCTL_SHOW_FAIL: "1" });
    expect(observationDenied.exitCode).toBe(1);
    expect(observationDenied.commands).toHaveLength(1);
    const stopDenied = await runController("stop", { TEST_SYSTEMCTL_DENY: "stop" });
    expect(stopDenied.exitCode).toBe(1);
    expect(stopDenied.commands).toEqual([
      "show --property=LoadState --value supacloud-gotrue@project-a", "stop supacloud-gotrue@project-a",
    ]);
    const disableDenied = await runController("stop", { TEST_SYSTEMCTL_DENY: "disable" });
    expect(disableDenied.exitCode).toBe(1);
    const stopped = await runController("stop");
    expect(stopped.exitCode).toBe(0);
    expect(stopped.commands).toEqual([
      "show --property=LoadState --value supacloud-gotrue@project-a",
      "stop supacloud-gotrue@project-a", "disable supacloud-gotrue@project-a",
    ]);
  });
});
