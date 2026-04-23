import { describe, test, expect } from "bun:test";
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
    expect(config.masterToken.length).toBeGreaterThan(0);
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

  test("should default port to 9090", () => {
    // 默认配置应为 9090
    expect(config.port).toBe(9090);
  });
});
