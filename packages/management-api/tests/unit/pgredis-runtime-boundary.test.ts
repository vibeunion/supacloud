import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function composeService(source: string, service: string): string {
  const marker = `\n  ${service}:`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing Compose service boundary: ${service}`);
  const body = source.slice(start + marker.length);
  const nextBoundary = body.search(/\n(?:  [a-zA-Z0-9_-]+:|volumes:|networks:)\n/);
  return nextBoundary < 0 ? body : body.slice(0, nextBoundary);
}

describe("pgredis-runtime platform boundary", () => {
  test("installs a dedicated systemd data plane before the Management API", () => {
    const installer = readRepoFile("install.sh");
    const runtimeUnit = readRepoFile("infrastructure/systemd/supacloud-pgredis-runtime.service");
    const edgeUnit = readRepoFile("infrastructure/systemd/supacloud-edge-runtime.service");

    expect(installer.indexOf("install_pgredis_runtime\n")).toBeLessThan(installer.indexOf("install_management_api\n"));
    expect(installer).toContain("select_pgredis_runtime_binary_source");
    expect(installer).toContain("PGREDIS_RUNTIME_INTERNAL_URL");
    expect(installer).toContain("begin_pgredis_install_transaction");
    expect(installer).toContain("rollback_pgredis_install_transaction");
    expect(installer).toContain('trap \'abort_pgredis_install_transaction "$?"\' ERR EXIT');
    expect(installer).toContain("abort_pgredis_install_transaction 143");
    expect(installer).toContain('supacloud_capture_file_snapshot "$PGREDIS_RUNTIME_BIN_FILE"');
    expect(installer).toContain('supacloud_capture_directory_snapshot "$PGREDIS_RUNTIME_SOURCE_DIR"');
    expect(runtimeUnit).toContain("EnvironmentFile=-/etc/supabase/pgredis-runtime.env");
    expect(runtimeUnit).toContain("ExecStart=/usr/local/bin/supacloud-pgredis-runtime");
    expect(runtimeUnit).toContain("User=supacloud-pgredis");
    expect(runtimeUnit).toContain("Environment=PGREDIS_RUNTIME_HOST=127.0.0.1");
    expect(runtimeUnit).toContain("127.0.0.1:@EDGE_RUNTIME_PORT@/health");
    expect(installer).toContain('PGREDIS_RUNTIME_PORT="${PGREDIS_RUNTIME_PORT:-9011}"');
    expect(installer).toContain("PGREDIS_RUNTIME_PORT=9010 conflicts with the SupaCloud Imaginary service");
    expect(installer).toContain("SUPACLOUD_PGBACKREST_CONFIG");
    expect(runtimeUnit).toContain("ExecStartPost=/usr/bin/curl");
    expect(edgeUnit).toContain("supacloud-pgredis-runtime.service");
    expect(edgeUnit).toContain("User=supacloud-edge");
    expect(edgeUnit).toContain("Group=supacloud-edge");
    expect(edgeUnit).toContain("EnvironmentFile=-/etc/supabase/edge-runtime.env");
    expect(edgeUnit).toContain("InaccessiblePaths=/etc/supabase/pgredis-tenants");
    expect(edgeUnit).not.toContain("EnvironmentFile=-/etc/supabase/management-api.env");
    expect(installer).toContain("ensure_edge_runtime_user");
    expect(installer).toContain('if ! capture_management_api_install "$management_transaction_dir"');
    expect(installer).toContain('recover_management_api_install "$transaction_dir" "$service_was_active" "$keep_current_env"');
    expect(installer.indexOf("commit_pgredis_install_transaction", installer.indexOf('log_info "SupaCloud Management API is healthy"')))
      .toBeLessThan(installer.indexOf("supacloud_upgrade_gotrue_binary"));
  });

  test("keeps pgredis private to Edge and PostgreSQL networks", () => {
    for (const composePath of ["docker/dev/docker-compose.yml", "docker/self-host/docker-compose.yml"]) {
      const compose = readRepoFile(composePath);
      const pgredis = composeService(compose, "pgredis-runtime");
      const caddy = composeService(compose, "caddy");

      expect(pgredis).not.toContain("ports:");
      expect(pgredis).toContain("pgredis-database");
      expect(pgredis).toContain("edge-pgredis");
      expect(pgredis).toContain("pgredis-tenant-config");
      expect(pgredis).not.toContain("tenant-config:/etc/supabase/tenants");
      expect(caddy).not.toContain("pgredis-runtime");
      expect(caddy).not.toContain("edge-pgredis");
    }
  });

  test("does not add a second queue or gateway rate limiter", () => {
    const runtimeApp = readRepoFile("packages/pgredis-runtime/src/app.ts");
    const runtimePackage = readRepoFile("packages/pgredis-runtime/package.json");
    const sdk = readRepoFile("packages/supacloud-js/src/index.ts");

    expect(runtimeApp).not.toContain('t.Literal("queue")');
    expect(runtimeApp).not.toContain('t.Literal("rateLimit")');
    expect(runtimePackage).not.toContain("pg-boss");
    expect(sdk).toContain("pgmq_public");
  });

  test("keeps PostgreSQL credentials and cache state out of the Worker singleton", () => {
    const tenantRuntime = readRepoFile("packages/management-api/src/services/tenant-runtime.service.ts");
    const edgeManager = readRepoFile("packages/management-api/src/plugins/edge-runtime-manager.ts");
    const managementConfig = readRepoFile("packages/management-api/src/config.ts");
    const denoCompat = readRepoFile("packages/edge-runtime/deno-compat.ts");

    expect(tenantRuntime).not.toContain('renderSystemdEnvLine("SUPABASE_DB_URL"');
    expect(edgeManager).not.toContain("...process.env");
    expect(edgeManager).toContain("EDGE_RUNTIME_USER requires setpriv");
    expect(managementConfig).toContain('process.platform === "linux" ? "supacloud-edge" : ""');
    expect(denoCompat).not.toContain("kvStores");
    expect(denoCompat).toContain("Deno.openKv is disabled");
  });
});
