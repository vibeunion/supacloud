import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { config } from "../../src/config";

describe("Config", () => {
  test("should have port configured", () => {
    expect(config.port).toBeGreaterThan(0);
    expect(config.port).toBeLessThan(65536);
  });

  test("should default max request body size above Bun's 128 MiB default", () => {
    expect(config.maxRequestBodySize).toBeGreaterThan(128 * 1024 * 1024);
  });

  test("should have database URL", () => {
    expect(config.databaseUrl).toBeDefined();
    expect(config.databaseUrl.length).toBeGreaterThan(0);
    expect(config.databaseUrl).toContain("postgresql://");
  });

  test("should have master token", () => {
    expect(config.masterToken).toBeDefined();
    expect(typeof config.masterToken).toBe("string");
  });

  test("should have scripts path", () => {
    expect(config.scriptsPath).toBeDefined();
    expect(config.scriptsPath.length).toBeGreaterThan(0);
  });

  test("should have base domain", () => {
    expect(config.baseDomain).toBeDefined();
    expect(config.baseDomain.length).toBeGreaterThan(0);
  });

  test("should have S3 endpoint", () => {
    expect(config.s3Endpoint).toBeDefined();
    expect(config.s3Endpoint).toContain("http");
  });

  test("port should match numeric env/config resolution", () => {
    expect(Number.isInteger(config.port)).toBe(true);
    expect(config.port).toBeGreaterThan(0);
  });

  test("PostgREST runtime budget should handle large REST payloads", () => {
    expect(config.postgrestRts).toContain("-M256m");
    expect(config.postgrestMemoryMax).toBe("384M");
    expect(config.postgrestCpuWeight).toBeGreaterThanOrEqual(40);
    expect(config.postgrestDbPool).toBe(10);
  });

  test("empty PGPASSWORD falls back to PG_PASSWORD", () => {
    const configModule = resolve(import.meta.dir, "../../src/config.ts");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { config } from ${JSON.stringify(configModule)}; process.stdout.write(config.pgPassword);`,
      ],
      env: {
        ...process.env,
        NODE_ENV: "test",
        SUPACLOUD_MANAGEMENT_ENV_FILE: "/nonexistent-management-env",
        SUPACLOUD_LOCAL_ENV_FILE: "/nonexistent-local-env",
        PGPASSWORD: "",
        PG_PASSWORD: "fallback-password",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("fallback-password");
  });

  test("non-empty PGPASSWORD preserves leading and trailing whitespace", () => {
    const configModule = resolve(import.meta.dir, "../../src/config.ts");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { config } from ${JSON.stringify(configModule)}; process.stdout.write(config.pgPassword);`,
      ],
      env: {
        ...process.env,
        NODE_ENV: "test",
        SUPACLOUD_MANAGEMENT_ENV_FILE: "/nonexistent-management-env",
        SUPACLOUD_LOCAL_ENV_FILE: "/nonexistent-local-env",
        PGPASSWORD: "  padded password  ",
        PG_PASSWORD: "fallback-password",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("  padded password  ");
  });
});
