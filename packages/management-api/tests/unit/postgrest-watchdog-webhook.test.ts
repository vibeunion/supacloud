import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const portableTest = process.platform === "win32" ? test.skip : test;

portableTest("watchdog webhooks validate deadlines and isolate delivery failures", () => {
  const script = fileURLToPath(new URL(
    "../../../../scripts/lib/postgrest_watchdog_webhook.test.sh", import.meta.url,
  ));
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, SUPACLOUD_WATCHDOG_TEST_SCRIPT: "" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Watchdog webhook regression failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stdout).toContain("postgrest_watchdog_webhook.test.sh: OK");
}, 30_000);
