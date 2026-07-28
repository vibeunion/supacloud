import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEdgeRuntimeChildEnv,
  buildEdgeRuntimeCommand,
  isEdgeRuntimeReadyResponse,
} from "../../src/plugins/edge-runtime-manager";

const repoRoot = join(import.meta.dir, "../../..", "..");

describe("embedded Edge Runtime process boundary", () => {
  test("passes only the Edge allowlist and explicit request-plane credentials", () => {
    const env = buildEdgeRuntimeChildEnv({
      PATH: "/usr/bin",
      DATABASE_URL: "postgresql://management-secret",
      PGPASSWORD: "management-password",
      PGREDIS_TENANT_CONFIG_DIR: "/etc/supabase/pgredis-tenants",
      PGREDIS_RUNTIME_INTERNAL_URL: "http://127.0.0.1:9010",
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "request-plane-token",
      WORKER_POOL_SIZE: "4",
    }, {
      EDGE_RUNTIME_MASTER_KEY: "edge-master-token",
      MANAGEMENT_API_URL: "http://127.0.0.1:9090",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      PGREDIS_RUNTIME_INTERNAL_URL: "http://127.0.0.1:9010",
      PGREDIS_RUNTIME_INTERNAL_TOKEN: "request-plane-token",
      WORKER_POOL_SIZE: "4",
      EDGE_RUNTIME_MASTER_KEY: "edge-master-token",
      MANAGEMENT_API_URL: "http://127.0.0.1:9090",
    });
  });

  test("rejects an empty runtime user when Management API runs as root", () => {
    expect(() => buildEdgeRuntimeCommand("/opt/supacloud/edge-runtime/server.ts", {
      bunPath: "/usr/local/bin/bun",
      user: "",
      group: "",
      isRoot: true,
      setprivPath: "/usr/bin/setpriv",
    })).toThrow("EDGE_RUNTIME_USER is required");
  });

  test("uses setpriv for an embedded runtime launched by root", () => {
    expect(buildEdgeRuntimeCommand("/opt/supacloud/edge-runtime/server.ts", {
      bunPath: "/usr/local/bin/bun",
      user: "supacloud-edge",
      group: "supacloud-edge",
      isRoot: true,
      setprivPath: "/usr/bin/setpriv",
    })).toEqual([
      "/usr/bin/setpriv",
      "--reuid",
      "supacloud-edge",
      "--regid",
      "supacloud-edge",
      "--clear-groups",
      "--",
      "/usr/local/bin/bun",
      "run",
      "/opt/supacloud/edge-runtime/server.ts",
    ]);
  });

  test("never terminates a process merely because it owns the configured port", () => {
    const manager = readFileSync(join(repoRoot, "packages/management-api/src/plugins/edge-runtime-manager.ts"), "utf8");

    expect(manager).not.toContain("killStaleListeners");
    expect(manager).not.toContain("process.kill(");
    expect(manager).not.toContain("lsof -iTCP");
    expect(manager).toContain("port may be occupied by another service");
  });

  test("accepts readiness only from the child instance that was launched", () => {
    const instanceId = "edge-instance-expected";

    expect(isEdgeRuntimeReadyResponse({ status: "ok", instanceId }, instanceId)).toBe(true);
    expect(isEdgeRuntimeReadyResponse({ status: "ok" }, instanceId)).toBe(false);
    expect(isEdgeRuntimeReadyResponse({ status: "ok", instanceId: "unrelated-listener" }, instanceId)).toBe(false);
    expect(isEdgeRuntimeReadyResponse("ok", instanceId)).toBe(false);
  });
});
