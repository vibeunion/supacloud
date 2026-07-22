import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..", "..");

describe("Realtime systemd deployment", () => {
  test("global Realtime unit does not sandbox podman syscalls", () => {
    const unit = readFileSync(
      join(repoRoot, "infrastructure/systemd/supacloud-realtime.service"),
      "utf8",
    );

    expect(unit).toContain("SupaCloud Realtime Service");
    expect(unit).toContain("podman run --replace");
    expect(unit).toContain("LogsDirectory=supacloud");
    expect(unit).toContain("Environment=REALTIME_IMAGE=public.ecr.aws/supabase/realtime:v2.116.1");
    expect(unit).toContain("Environment=REALTIME_CONTAINER_NAME=supacloud-realtime");
    expect(unit).toContain("Environment=REALTIME_DB_USER=supabase_admin");
    expect(unit).toContain("Environment=PG_DATABASE=supacloud_meta");
    expect(unit).toContain("$${#REALTIME_DB_ENC_KEY}");
    expect(unit).toContain("test -n \"$$PGPASSWORD\"");
    expect(unit).toContain("-e DB_USER_REALTIME=${REALTIME_DB_USER}");
    expect(unit).toContain("-e DB_PASS_REALTIME=${PGPASSWORD}");
    expect(unit).toContain("-e RUN_JANITOR=false");
    expect(unit).not.toContain("SystemCallFilter=");
    expect(unit).not.toContain("DB_AFTER_CONNECT_QUERY");
  });

  test("installer pre-pulls and tags the Realtime image before systemd restart", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const realtimeSection = installer.slice(
      installer.indexOf("# --- 2. Deploy Supabase Realtime"),
      installer.indexOf("# --- 3. Update management API env"),
    );

    expect(realtimeSection).toContain("REALTIME_IMAGE_PULL");
    expect(realtimeSection).toContain("$RUNTIME pull \"$REALTIME_IMAGE_PULL\"");
    expect(realtimeSection).toContain("$RUNTIME tag \"$REALTIME_IMAGE_PULL\" \"$REALTIME_IMAGE_VALUE\"");
    expect(realtimeSection).toContain("start_realtime_container");
    expect(installer).toContain('--env-file "$realtime_env_file"');
    expect(realtimeSection).toContain("render_realtime_systemd_unit");
    expect(realtimeSection).not.toContain("-e DB_PASS_REALTIME");
    expect(realtimeSection).not.toContain("-e JWT_SECRET");
    expect(realtimeSection.indexOf("$RUNTIME pull")).toBeLessThan(
      realtimeSection.indexOf("systemctl restart supacloud-realtime"),
    );
  });
});

describe("Management API CI Realtime readiness probe", () => {
  test("signs an admin JWT and uses the v2.111+ healthcheck route", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/management-api.yml"), "utf8");
    const waitStep = workflow.slice(
      workflow.indexOf("Waiting for Realtime container to be ready"),
      workflow.indexOf('echo "Waiting for MinIO container to be ready..."'),
    );

    // v2.111+ requires a signed HS256 JWT, not the raw JWT_SECRET string.
    expect(waitStep).toContain("REALTIME_ADMIN_TOKEN");
    expect(waitStep).toContain("createHmac(\"sha256\",s)");
    expect(waitStep).toContain("Authorization: Bearer ${REALTIME_ADMIN_TOKEN}");

    // /health returns 404 on v2.111+; the basic health fallback uses /healthcheck.
    expect(waitStep).toContain("http://127.0.0.1:4000/healthcheck");

    // Guard against regressing to the raw-secret probe that returns 403.
    expect(waitStep).not.toContain("Authorization: Bearer ${JWT_SECRET}");
    expect(waitStep).not.toContain("http://127.0.0.1:4000/health\"");
  });

  test("starts the API with an explicit matching Realtime container secret fixture", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/management-api.yml"), "utf8");
    const launchStep = workflow.slice(
      workflow.indexOf("Launch API & Execute Full Defenses"),
      workflow.indexOf("Stop containers"),
    );

    expect(launchStep).toContain("SUPACLOUD_REALTIME_CONTAINER_ENV_FILE");
    expect(launchStep).toContain("API_JWT_SECRET=%s");
    expect(launchStep).toContain("TEST_FIXED_JWT_SECRET");
  });
});
