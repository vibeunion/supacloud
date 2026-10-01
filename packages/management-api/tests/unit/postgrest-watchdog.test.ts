import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The tenant watchdog is a Linux/systemd script. This bridge places its shell
// regression under Management API CI's required Unit Tests job.
const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("tenant PostgREST watchdog preserves transport and configuration boundaries", () => {
  const script = fileURLToPath(new URL(
    "../../../../scripts/lib/postgrest_watchdog.test.sh", import.meta.url,
  ));
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, SUPACLOUD_WATCHDOG_TEST_SCRIPT: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Watchdog regression failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stdout).toContain("postgrest_watchdog.test.sh: OK");
}, 30_000);
