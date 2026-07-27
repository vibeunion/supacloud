import { createPgredisRuntimeApp } from "./src/app";
import { TenantCacheRegistry } from "./src/cache-registry";
import { loadPgredisRuntimeConfig } from "./src/config";

const config = loadPgredisRuntimeConfig();
const registry = new TenantCacheRegistry({
  tenantsDir: config.tenantsDir,
  maxTenants: config.maxTenants,
  connectionsPerTenant: config.connectionsPerTenant,
  tenantIdleMs: config.tenantIdleMs,
  l1MaxEntries: config.l1MaxEntries,
  l1TtlMs: config.l1TtlMs,
});
const app = createPgredisRuntimeApp({
  signingSecret: config.internalToken,
  capabilityMaxTtlMs: config.capabilityMaxTtlMs,
  maxValueBytes: config.maxValueBytes,
  maxTtlMs: config.maxTtlMs,
  registry,
});

app.listen({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: config.maxRequestBodyBytes,
});

console.log(`[pgredis-runtime] listening on ${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.stop(true);
  await registry.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
