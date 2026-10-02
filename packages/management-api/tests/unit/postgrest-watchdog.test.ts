import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The watchdog runs under Linux/systemd in production, but its shell regression
// drives the script through local fakes and is portable, so it runs wherever
// bash is available to keep a behavioural signal on developer machines too.
const portableTest = process.platform === "win32" ? test.skip : test;

portableTest("tenant PostgREST watchdog preserves transport and configuration boundaries", () => {
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
