import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../../src/config";
import { configuredApplicationPortRange, isApplicationPortAvailable } from "../../src/services/application-runtime-allocation";

const initial = {
  applicationRuntimePortRange: config.applicationRuntimePortRange, portRange: config.portRange,
  pgrstPortBase: config.pgrstPortBase, gotruePortBase: config.gotruePortBase,
  jitDatabaseGatewayPortRange: config.jitDatabaseGatewayPortRange,
  port: config.port, pgPort: config.pgPort, poolerPort: config.poolerPort, caddyAdminUrl: config.caddyAdminUrl,
};
beforeEach(() => Object.assign(config, {
  applicationRuntimePortRange: "20000-29999", portRange: "3100-3299",
  pgrstPortBase: 3100, gotruePortBase: 3200, jitDatabaseGatewayPortRange: "6600-6699",
  port: 9090, pgPort: 5432, poolerPort: 6543, caddyAdminUrl: "http://127.0.0.1:2019",
}));
afterEach(() => Object.assign(config, initial));

test("default application pool is disjoint from platform allocations", () => {
  expect(configuredApplicationPortRange()).toEqual({ start: 20000, end: 29999 });
  for (const range of ["30000-30100", "6600-6700", "3300-3301", "9090-9100", "5432-5433", "6543-6544", "2019-2020"]) {
    config.applicationRuntimePortRange = range;
    expect(() => configuredApplicationPortRange()).toThrow("OVERLAP");
  }
});
test("invalid pool bounds and conflicting tenant configuration are rejected", () => {
  for (const range of ["0-1", "30000-20000", "65535-65536", "20000", "NaN-29999"]) {
    config.applicationRuntimePortRange = range;
    expect(() => configuredApplicationPortRange()).toThrow("INVALID");
  }
  config.applicationRuntimePortRange = "20000-29999";
  config.pgrstPortBase = 19900;
  expect(() => configuredApplicationPortRange()).toThrow("OVERLAP");
});
test("loopback availability observes a real listener and releases successful probes", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  try { expect(await isApplicationPortAvailable(port)).toBe(false); }
  finally { await server.stop(true); }
  expect(await isApplicationPortAvailable(port)).toBe(true);
  expect(await isApplicationPortAvailable(port)).toBe(true);
});
