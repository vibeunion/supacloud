import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import {
  isPostgrestLauncherDigestCommand,
  isPostgrestProcessIdentityProbeCommand,
  isPostgrestProcessIdentityTerminationCommand,
  isStandaloneVersionCommand,
  isSystemdUnitBrokerDigestCommand,
} from "../../src/standalone";
import {
  POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
  POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
} from "../../src/services/postgrest-process-identity";
import { EMBEDDED_POSTGREST_LAUNCHER_SHA256 } from "../../src/embedded-postgrest-launcher";
import { EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256 } from "../../src/embedded-systemd-unit-broker";

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
    expect(isSystemdUnitBrokerDigestCommand(["--systemd-unit-helper-sha256"])).toBe(true);
    expect(isSystemdUnitBrokerDigestCommand(["upgrade", "--systemd-unit-helper-sha256"])).toBe(false);
    expect(isPostgrestLauncherDigestCommand(["--postgrest-launcher-sha256"])).toBe(true);
    expect(isPostgrestLauncherDigestCommand(["upgrade", "--postgrest-launcher-sha256"])).toBe(false);
    expect(isPostgrestProcessIdentityProbeCommand([
      POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
      "4172",
      "981",
      "981",
    ])).toBe(true);
    expect(isPostgrestProcessIdentityProbeCommand([POSTGREST_PROCESS_IDENTITY_PROBE_FLAG])).toBe(false);
    expect(isPostgrestProcessIdentityProbeCommand(["upgrade", POSTGREST_PROCESS_IDENTITY_PROBE_FLAG])).toBe(false);
    expect(isPostgrestProcessIdentityTerminationCommand([
      POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
      "4172",
      "981",
      "981",
      "987654321",
    ])).toBe(true);
    expect(isPostgrestProcessIdentityTerminationCommand([
      POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
      "4172",
    ])).toBe(false);
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
    expect(version.stdout).toBe(`SupaCloud Version: ${pkg.version}\n`);
    expect(version.stderr).toBe("");

    const helperDigest = await captureProcess([binaryPath, "--systemd-unit-helper-sha256"], 5_000);
    expect(helperDigest.timedOut).toBe(false);
    expect(helperDigest.exitCode).toBe(0);
    expect(helperDigest.stdout).toBe(
      `SupaCloud systemd-unit helper SHA-256: ${EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256}\n`,
    );
    expect(helperDigest.stderr).toBe("");

    const launcherDigest = await captureProcess([binaryPath, "--postgrest-launcher-sha256"], 5_000);
    expect(launcherDigest.timedOut).toBe(false);
    expect(launcherDigest.exitCode).toBe(0);
    expect(launcherDigest.stdout).toBe(
      `SupaCloud PostgREST launcher SHA-256: ${EMBEDDED_POSTGREST_LAUNCHER_SHA256}\n`,
    );
    expect(launcherDigest.stderr).toBe("");

    const invalidIdentityProbe = await captureProcess([
      binaryPath,
      POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
      "invalid",
      "981",
      "981",
    ], 5_000);
    expect(invalidIdentityProbe.timedOut).toBe(false);
    expect(invalidIdentityProbe.exitCode).not.toBe(0);
    expect(invalidIdentityProbe.stdout).toBe("");
    expect(invalidIdentityProbe.stderr).toBe("PostgREST process identity probe failed\n");

    const invalidIdentityTermination = await captureProcess([
      binaryPath,
      POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
      "invalid",
      "981",
      "981",
      "987654321",
    ], 5_000);
    expect(invalidIdentityTermination.timedOut).toBe(false);
    expect(invalidIdentityTermination.exitCode).not.toBe(0);
    expect(invalidIdentityTermination.stdout).toBe("");
    expect(invalidIdentityTermination.stderr).toBe("PostgREST process identity termination failed\n");
  }, 40_000);
});
