import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cleanEnv(overrides: Record<string, string>) {
  const env = { ...process.env } as Record<string, string>;
  for (const key of [
    "S3_STORAGE_TYPE",
    "STORAGE_TYPE",
    "NODE_ENV",
    "BUN_ENV",
    "CI",
    "GITHUB_ACTIONS",
    "SUPACLOUD_LOAD_LEGACY_CONFIG_ENV",
    "SUPACLOUD_MANAGEMENT_ENV_FILE",
    "SUPACLOUD_LEGACY_CONFIG_ENV_FILE",
    "SUPACLOUD_LOCAL_ENV_FILE",
    "SUPAOAUTH_BFF_SIGNING_SECRET",
    "LEGACY_SECRETS_ENCRYPTION_KEY",
    "DOCKER_HOST_IP",
    "INTERNAL_IP",
    "SUPACLOUD_CADDY_TLS_ISSUER",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    MASTER_TOKEN: "production-master-token-0123456789abcdef",
    JWT_SECRET: "production-jwt-secret-0123456789abcdef",
    DASHBOARD_PASSWORD: "production-dashboard-password",
    SECRETS_ENCRYPTION_KEY: "production-encryption-key-0123456789abcdef",
    SUPAOAUTH_BFF_SIGNING_SECRET: "production-bff-signing-secret-0123456789abcdef",
    ...overrides,
  };
}

function loadStorageType(env: Record<string, string>) {
  const result = spawnSync("bun", ["-e", [
    'import { config } from "./src/config.ts";',
    'console.log(`RESULT=${config.storageType}`);',
  ].join(" ")], { cwd: packageRoot, env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.match(/RESULT=([^\n]+)/)?.[1];
}

function loadNodeEnvironment(env: Record<string, string>) {
  const result = spawnSync("bun", ["-e", [
    'import { config } from "./src/config.ts";',
    'console.log(`RESULT=${config.nodeEnv}:${process.env.NODE_ENV}`);',
  ].join(" ")], { cwd: packageRoot, env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.match(/RESULT=([^\n]+)/)?.[1];
}

function loadDatabaseUrl(env: Record<string, string>) {
  const result = spawnSync("bun", ["-e", [
    'import { config } from "./src/config.ts";',
    'console.log(`RESULT=${config.databaseUrl}`);',
  ].join(" ")], { cwd: packageRoot, env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.match(/RESULT=([^\n]+)/)?.[1];
}

function loadCaddyTlsIssuer(env: Record<string, string>) {
  const configProcess = spawnSync("bun", ["-e", [
    'import { config } from "./src/config.ts";',
    'console.log(`RESULT=${config.caddyTlsIssuer}`);',
  ].join(" ")], { cwd: packageRoot, env, encoding: "utf8" });
  expect(configProcess.status, configProcess.stderr).toBe(0);
  return configProcess.stdout.match(/RESULT=([^\n]+)/)?.[1];
}

describe("production config loading boundaries", () => {
  test("defaults Caddy TLS to the internal CA for local and private addresses", () => {
    for (const address of [
      "127.0.0.2",
      "localhost",
      "::1",
      "10.0.0.8",
      "172.31.255.254",
      "192.168.10.20",
      "169.254.10.20",
      "fd00::8",
      "fe80::8",
    ]) {
      expect(loadCaddyTlsIssuer(cleanEnv({
        NODE_ENV: "production",
        DOCKER_HOST_IP: address,
      }))).toBe("internal");
    }
  });

  test("keeps public hosts on ACME and honors explicit issuer overrides", () => {
    expect(loadCaddyTlsIssuer(cleanEnv({ NODE_ENV: "production" }))).toBe("internal");
    expect(loadCaddyTlsIssuer(cleanEnv({
      NODE_ENV: "production",
      DOCKER_HOST_IP: "198.51.100.10",
    }))).toBe("acme");
    expect(loadCaddyTlsIssuer(cleanEnv({
      NODE_ENV: "production",
      DOCKER_HOST_IP: "10.0.0.8",
      SUPACLOUD_CADDY_TLS_ISSUER: "acme",
    }))).toBe("acme");
    expect(loadCaddyTlsIssuer(cleanEnv({
      NODE_ENV: "production",
      DOCKER_HOST_IP: "198.51.100.10",
      SUPACLOUD_CADDY_TLS_ISSUER: "internal",
    }))).toBe("internal");
  });

  test("defaults Caddy TLS to the internal CA when configured addresses are empty", () => {
    expect(loadCaddyTlsIssuer(cleanEnv({
      NODE_ENV: "production",
      DOCKER_HOST_IP: "",
    }))).toBe("internal");
    expect(loadCaddyTlsIssuer(cleanEnv({
      NODE_ENV: "production",
      INTERNAL_IP: "",
    }))).toBe("internal");
  });

  test("rejects an invalid explicit Caddy TLS issuer", () => {
    const configProcess = spawnSync("bun", ["-e", 'import "./src/config.ts";'], {
      cwd: packageRoot,
      env: cleanEnv({
        NODE_ENV: "production",
        SUPACLOUD_CADDY_TLS_ISSUER: "self-signed",
      }),
      encoding: "utf8",
    });

    expect(configProcess.status).not.toBe(0);
    expect(configProcess.stderr).toContain("SUPACLOUD_CADDY_TLS_ISSUER");
  });

  test("accepts standard postgres and postgresql DSN schemes", () => {
    for (const scheme of ["postgres", "postgresql"]) {
      const databaseUrl = `${scheme}://postgres:secret@localhost:5432/supacloud`;
      expect(loadDatabaseUrl(cleanEnv({ NODE_ENV: "production", DATABASE_URL: databaseUrl })))
        .toBe(databaseUrl);
    }
  });

  test("rejects a BFF signing secret shared with another privileged key", () => {
    const sharedSecret = "shared-privileged-secret-0123456789abcdef";
    const result = spawnSync("bun", ["-e", 'import "./src/config.ts";'], {
      cwd: packageRoot,
      env: cleanEnv({
        NODE_ENV: "production",
        MASTER_TOKEN: sharedSecret,
        SUPAOAUTH_BFF_SIGNING_SECRET: sharedSecret,
      }),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SUPAOAUTH_BFF_SIGNING_SECRET");
  });

  test("accepts the old master token only as a distinct migration key", () => {
    const result = spawnSync("bun", ["-e", 'import "./src/config.ts";'], {
      cwd: packageRoot,
      env: cleanEnv({
        NODE_ENV: "production",
        LEGACY_SECRETS_ENCRYPTION_KEY: "production-master-token-0123456789abcdef",
      }),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  test("rejects a legacy migration key shared with the current encryption key", () => {
    const sharedKey = "shared-encryption-key-0123456789abcdef";
    const result = spawnSync("bun", ["-e", 'import "./src/config.ts";'], {
      cwd: packageRoot,
      env: cleanEnv({
        NODE_ENV: "production",
        SECRETS_ENCRYPTION_KEY: sharedKey,
        LEGACY_SECRETS_ENCRYPTION_KEY: sharedKey,
      }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LEGACY_SECRETS_ENCRYPTION_KEY");
  });

  test("management runtime env wins and tracked config.env is ignored in production", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-config-loading-"));
    tempDirs.push(dir);
    const management = join(dir, "management-api.env");
    const legacy = join(dir, "config.env");
    const local = join(dir, ".env");
    writeFileSync(management, "S3_STORAGE_TYPE=external\n");
    writeFileSync(legacy, "S3_STORAGE_TYPE=juicefs\n");
    writeFileSync(local, "S3_STORAGE_TYPE=minio\n");

    expect(loadStorageType(cleanEnv({
      NODE_ENV: "production",
      SUPACLOUD_MANAGEMENT_ENV_FILE: management,
      SUPACLOUD_LEGACY_CONFIG_ENV_FILE: legacy,
      SUPACLOUD_LOCAL_ENV_FILE: local,
    }))).toBe("external");
  });

  test("legacy config requires explicit opt-in and cannot override explicit environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-config-legacy-"));
    tempDirs.push(dir);
    const missingManagement = join(dir, "missing-management.env");
    const legacy = join(dir, "config.env");
    writeFileSync(legacy, "S3_STORAGE_TYPE=external\n");

    expect(loadStorageType(cleanEnv({
      NODE_ENV: "production",
      SUPACLOUD_MANAGEMENT_ENV_FILE: missingManagement,
      SUPACLOUD_LEGACY_CONFIG_ENV_FILE: legacy,
    }))).toBe("juicefs");

    expect(loadStorageType(cleanEnv({
      NODE_ENV: "production",
      SUPACLOUD_LOAD_LEGACY_CONFIG_ENV: "true",
      SUPACLOUD_MANAGEMENT_ENV_FILE: missingManagement,
      SUPACLOUD_LEGACY_CONFIG_ENV_FILE: legacy,
    }))).toBe("external");

    expect(loadStorageType(cleanEnv({
      NODE_ENV: "production",
      S3_STORAGE_TYPE: "minio",
      SUPACLOUD_LOAD_LEGACY_CONFIG_ENV: "true",
      SUPACLOUD_MANAGEMENT_ENV_FILE: missingManagement,
      SUPACLOUD_LEGACY_CONFIG_ENV_FILE: legacy,
    }))).toBe("minio");
  });

  test("management runtime env establishes global production semantics when NODE_ENV is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-config-node-env-"));
    tempDirs.push(dir);
    const management = join(dir, "management-api.env");
    writeFileSync(management, "S3_STORAGE_TYPE=external\n");

    expect(loadNodeEnvironment(cleanEnv({
      SUPACLOUD_MANAGEMENT_ENV_FILE: management,
    }))).toBe("production:production");

    expect(loadNodeEnvironment(cleanEnv({
      BUN_ENV: "test",
      SUPACLOUD_MANAGEMENT_ENV_FILE: management,
    }))).toBe("test:test");
  });
});
