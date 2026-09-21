// @supacloud-test-isolate
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "supacloud-health-disk-"));
const envKeys = ["PATH", "FIXTURE_DF_OUTPUT", "FIXTURE_DF_EXIT"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
for (const [name, body] of [
  ["df", 'printf "%s\\n" "$FIXTURE_DF_OUTPUT"\nexit "${FIXTURE_DF_EXIT:-0}"'],
  ["mount", "exit 0"],
  ["systemctl", "exit 0"],
  ["pig", 'printf "pig fixture\\n"'],
]) {
  if (!name || body === undefined) throw new Error("Invalid executable fixture");
  const file = join(directory, name);
  await Bun.write(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o700);
}
const originalDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...originalDb,
  sql: async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("server_version")) return [{ server_version: "18.0" }];
    if (query.includes("replicas")) return [{ replicas: 0 }];
    return [];
  },
}));
mock.module("../../src/infra/cluster", () => ({ ClusterManager: { getStatus: async () => [] } }));
const { HealthChecker } = await import("../../src/infra/health");
await import("../../src/diagnostics/checks/platform-service");
const { getCheck } = await import("../../src/services/diagnostics.registry");

beforeEach(() => {
  process.env.PATH = `${directory}:${originalEnv.PATH ?? "/usr/bin:/bin"}`;
  process.env.FIXTURE_DF_EXIT = "0";
});
afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

test.each([
  { available: 9_000_000, usedPercent: 10, health: "OK", diagnostic: "pass" },
  { available: 0, usedPercent: 100, health: "WARN", diagnostic: "degraded" },
  { available: -1, usedPercent: 101, health: "WARN", diagnostic: "degraded" },
])("both disk checks interpret numeric fixture %#", async (fixture) => {
  process.env.FIXTURE_DF_OUTPUT = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 10000000 1000000 ${fixture.available} ${fixture.usedPercent}% /opt`;
  const reports = await HealthChecker.runFullCheck();
  const disk = reports.find(report => report.component === "Storage Space");
  expect(disk?.status).toBe(fixture.health);
  if (fixture.health === "OK") expect(disk).not.toHaveProperty("recommendation");
  const check = getCheck("platform-disk-space");
  if (!check) throw new Error("Missing platform disk check");
  expect((await check.run({ metaDb: originalDb.sql, scope: "platform", cache: new Map() }))?.status)
    .toBe(fixture.diagnostic);
});

test.each(["", "Filesystem 1024-blocks Used Available Capacity Mounted on\ntruncated"])(
  "both checks fail an unreadable disk report %#",
  async (output) => {
    process.env.FIXTURE_DF_OUTPUT = output;
    const reports = await HealthChecker.runFullCheck();
    expect(reports.find(report => report.component === "Storage Space")?.status).toBe("ERROR");
    const check = getCheck("platform-disk-space");
    if (!check) throw new Error("Missing platform disk check");
    expect((await check.run({ metaDb: originalDb.sql, scope: "platform", cache: new Map() }))?.status).toBe("error");
  },
);

test("a failed disk command cannot report healthy from partial stdout", async () => {
  process.env.FIXTURE_DF_OUTPUT = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 10000000 1000000 9000000 10% /opt";
  process.env.FIXTURE_DF_EXIT = "1";
  const reports = await HealthChecker.runFullCheck();
  expect(reports.find(report => report.component === "Storage Space")?.status).toBe("ERROR");
  const check = getCheck("platform-disk-space");
  if (!check) throw new Error("Missing platform disk check");
  expect((await check.run({ metaDb: originalDb.sql, scope: "platform", cache: new Map() }))?.status).toBe("error");
});
