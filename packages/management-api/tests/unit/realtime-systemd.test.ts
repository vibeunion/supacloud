import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "../../..", "..");

describe("Realtime systemd deployment", () => {
  function renderRealtimeEnv(seedSelfHost?: string, region?: string, image?: string) {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-realtime-env-test-"));
    const envFile = join(dir, "realtime.env");
    const serviceEnvFile = join(dir, "realtime-service.env");
    const renderedUnit = join(dir, "supacloud-realtime.service");
    const installer = join(repoRoot, "install.sh");
    const sourceUnit = join(repoRoot, "infrastructure/systemd/supacloud-realtime.service");
    const script = [
      "set -euo pipefail",
      "installer_path=$1",
      "source_unit=$2",
      "env_file=$3",
      "service_env_file=$4",
      "rendered_unit=$5",
      "set --",
      "source \"$installer_path\"",
      "printf 'STALE_CONTAINER_KEY=remove-me\\nAPI_JWT_SECRET=stale-secret\\n' > \"$env_file\"",
      "printf 'STALE_SERVICE_KEY=remove-me\\nREALTIME_API_SECRET=stale-secret\\n' > \"$service_env_file\"",
      "write_realtime_container_env \"$env_file\"",
      "write_realtime_service_env \"$service_env_file\" \"${REALTIME_IMAGE:-public.ecr.aws/supabase/realtime:v2.133.0}\" \"$env_file\"",
      "render_realtime_systemd_unit \"$source_unit\" \"$rendered_unit\" \"$env_file\" \"$service_env_file\"",
    ].join("\n");
    const childEnv = { ...process.env } as Record<string, string>;
    childEnv.POSTGRES_PASSWORD = "test-db-password";
    childEnv.JWT_SECRET = "test-jwt-secret";
    childEnv.REALTIME_DB_ENC_KEY = "1234567890abcdef";
    childEnv.REALTIME_SECRET_KEY_BASE = "test-secret-key-base";
    if (image === undefined) delete childEnv.REALTIME_IMAGE;
    else childEnv.REALTIME_IMAGE = image;
    delete childEnv.REALTIME_CONTAINER_NAME;
    delete childEnv.REALTIME_DB_USER;
    if (seedSelfHost === undefined) delete childEnv.REALTIME_SEED_SELF_HOST;
    else childEnv.REALTIME_SEED_SELF_HOST = seedSelfHost;
    if (region === undefined) delete childEnv.REALTIME_REGION;
    else childEnv.REALTIME_REGION = region;

    try {
      const result = spawnSync(
        "bash",
        ["-c", script, "bash", installer, sourceUnit, envFile, serviceEnvFile, renderedUnit],
        { env: childEnv, encoding: "utf8" },
      );
      return {
        result,
        envText: result.status === 0 ? readFileSync(envFile, "utf8") : "",
        serviceEnvFile,
        serviceEnvText: result.status === 0 ? readFileSync(serviceEnvFile, "utf8") : "",
        unitText: result.status === 0 ? readFileSync(renderedUnit, "utf8") : "",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("global Realtime unit does not sandbox podman syscalls", () => {
    const unit = readFileSync(
      join(repoRoot, "infrastructure/systemd/supacloud-realtime.service"),
      "utf8",
    );

    expect(unit).toContain("SupaCloud Realtime Service");
    expect(unit).toContain("podman run --replace");
    expect(unit).toContain("LogsDirectory=supacloud");
    expect(unit).toContain("Environment=REALTIME_IMAGE=public.ecr.aws/supabase/realtime:v2.133.0");
    expect(unit).toContain("Environment=REALTIME_CONTAINER_NAME=supacloud-realtime");
    expect(unit).toContain("Environment=REALTIME_DB_USER=supabase_admin");
    expect(unit).toContain("Environment=PG_DATABASE=supacloud_meta");
    expect(unit).toContain("Environment=REALTIME_CONTAINER_ENV_FILE=/etc/supabase/realtime-container.env");
    expect(unit).toContain("EnvironmentFile=-/etc/supabase/management-api.env");
    expect(unit).toContain("EnvironmentFile=/etc/supabase/realtime-service.env");
    expect(unit).toContain("$${#REALTIME_DB_ENC_KEY}");
    expect(unit).toContain("test -n \"$$PGPASSWORD\"");
    expect(unit).toContain("--env-file ${REALTIME_CONTAINER_ENV_FILE}");
    expect(unit).not.toContain("-e DB_PASS_REALTIME=");
    expect(unit).not.toContain("-e JWT_SECRET=");
    expect(unit).not.toContain("-e SECRET_KEY_BASE=");
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
    expect(realtimeSection).toContain("if ! systemctl restart supacloud-realtime; then");
    expect(realtimeSection).not.toContain(
      'systemctl restart supacloud-realtime || log_warn',
    );
  });

  test("renders the final env-file with a region and multi-tenant seed default", () => {
    const rendered = renderRealtimeEnv();

    expect(rendered.result.status).toBe(0);
    expect(rendered.envText).toContain("REGION=us-east-1\n");
    expect(rendered.envText).toContain("SEED_SELF_HOST=false\n");
    expect(rendered.envText).not.toContain("STALE_CONTAINER_KEY");
    expect(rendered.envText).not.toContain("stale-secret");
    expect(rendered.serviceEnvText).not.toContain("STALE_SERVICE_KEY");
    expect(rendered.serviceEnvText).not.toContain("REALTIME_API_SECRET");
    expect(rendered.unitText).toContain("--env-file ");
    expect(rendered.unitText).not.toContain("SEED_SELF_HOST=true");
  });

  test("release-owned Realtime settings override stale management values without hiding secrets", () => {
    const rendered = renderRealtimeEnv();
    expect(rendered.result.status).toBe(0);

    const managementEnvironment = new Map([
      ["REALTIME_IMAGE", "public.ecr.aws/supabase/realtime:v2.129.0"],
      ["REALTIME_CONTAINER_NAME", "stale-realtime"],
      ["REALTIME_DB_USER", "stale-user"],
      ["PG_DATABASE", "stale-database"],
      ["REALTIME_CONTAINER_ENV_FILE", "/tmp/stale-realtime.env"],
      ["REALTIME_SECRET_KEY_BASE", "secret-key-base"],
      ["REALTIME_DB_ENC_KEY", "1234567890abcdef"],
      ["SUPACLOUD_JWT_SECRET", "jwt-secret"],
      ["PGPASSWORD", "database-password"],
    ]);
    const unitEnvironment = new Map(
      rendered.unitText
        .split("\n")
        .filter((line) => line.startsWith("Environment="))
        .map((line) => {
          const separator = line.indexOf("=", "Environment=".length);
          return [
            line.slice("Environment=".length, separator),
            line.slice(separator + 1),
          ] as const;
        }),
    );
    const serviceEnvironment = new Map(
      rendered.serviceEnvText
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          const value = line.slice(separator + 1).replace(/^"|"$/g, "");
          return [line.slice(0, separator), value] as const;
        }),
    );

    // systemd applies Environment= first, then EnvironmentFile= entries in
    // their listed order. The required service file must therefore be last.
    const environmentFiles = rendered.unitText.match(/^EnvironmentFile=.*$/gm);
    expect(environmentFiles).toEqual([
      "EnvironmentFile=-/etc/supabase/management-api.env",
      `EnvironmentFile=${rendered.serviceEnvFile}`,
    ]);

    const effectiveEnvironment = new Map(unitEnvironment);
    for (const [key, value] of managementEnvironment) effectiveEnvironment.set(key, value);
    for (const [key, value] of serviceEnvironment) effectiveEnvironment.set(key, value);

    expect(effectiveEnvironment.get("REALTIME_IMAGE")).toBe(
      "public.ecr.aws/supabase/realtime:v2.133.0",
    );
    expect(effectiveEnvironment.get("REALTIME_CONTAINER_NAME")).toBe("supacloud-realtime");
    expect(effectiveEnvironment.get("REALTIME_DB_USER")).toBe("supabase_admin");
    expect(effectiveEnvironment.get("PG_DATABASE")).toBe("supacloud_meta");
    expect(effectiveEnvironment.get("REALTIME_CONTAINER_ENV_FILE")).toContain("realtime.env");
    expect(effectiveEnvironment.get("REALTIME_SECRET_KEY_BASE")).toBe("secret-key-base");
    expect(effectiveEnvironment.get("REALTIME_DB_ENC_KEY")).toBe("1234567890abcdef");
    expect(effectiveEnvironment.get("SUPACLOUD_JWT_SECRET")).toBe("jwt-secret");
    expect(effectiveEnvironment.get("PGPASSWORD")).toBe("database-password");
    expect(rendered.serviceEnvText).not.toContain("secret-key-base");
    expect(rendered.serviceEnvText).not.toContain("jwt-secret");

    const execStart = rendered.unitText.match(/^ExecStart=(.*)$/m)?.[1];
    expect(execStart).toBeDefined();
    const effectiveCommand = execStart!.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
      const value = effectiveEnvironment.get(key);
      if (value === undefined) throw new Error(`Missing effective systemd value: ${key}`);
      return value;
    });
    expect(effectiveCommand).toContain(
      "podman run --replace --name supacloud-realtime --network host --env-file ",
    );
    expect(effectiveCommand).toContain("public.ecr.aws/supabase/realtime:v2.133.0");
    expect(effectiveCommand).not.toContain("v2.129.0");
    expect(effectiveCommand).not.toContain("stale-realtime");

    const customImage = "registry.example.test/supabase/realtime:v2.133.0-custom";
    const custom = renderRealtimeEnv(undefined, undefined, customImage);
    expect(custom.result.status).toBe(0);
    expect(custom.serviceEnvText).toContain(`REALTIME_IMAGE="${customImage}"\n`);
  });

  test("allows an explicit single-host seed override and rejects invalid values", () => {
    const enabled = renderRealtimeEnv("true", "eu-west-1");
    expect(enabled.result.status).toBe(0);
    expect(enabled.envText).toContain("REGION=eu-west-1\n");
    expect(enabled.envText).toContain("SEED_SELF_HOST=true\n");

    const invalid = renderRealtimeEnv("1");
    expect(invalid.result.status).not.toBe(0);
    expect(`${invalid.result.stdout}\n${invalid.result.stderr}`).toContain(
      "REALTIME_SEED_SELF_HOST must be true or false",
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
