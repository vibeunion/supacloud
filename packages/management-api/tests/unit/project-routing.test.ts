import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  normalizeProjectRoutingConfig,
  normalizeBaseDomain,
  resolveTenantPorts,
  resolveProjectApiHost,
  resolveProjectApiUrl,
  resolveProjectBaseHost,
  resolveProjectStudioHost,
  resolveProjectStudioUrl,
} from "../../src/utils/project-routing";

const originalBaseDomain = config.baseDomain;
const originalEnableSsl = config.enableSsl;

afterEach(() => {
  config.baseDomain = originalBaseDomain;
  config.enableSsl = originalEnableSsl;
});

describe("project routing", () => {
  test("normalizes api/studio-prefixed base domains", () => {
    expect(normalizeBaseDomain("api.82.157.196.165.sslip.io")).toBe("82.157.196.165.sslip.io");
    expect(normalizeBaseDomain("studio.82.157.196.165.sslip.io")).toBe("82.157.196.165.sslip.io");
  });

  test("does not generate api.api host when BASE_DOMAIN includes api prefix", () => {
    config.baseDomain = "api.82.157.196.165.sslip.io";

    expect(resolveProjectBaseHost("77az24zz7p")).toBe("77az24zz7p.82.157.196.165.sslip.io");
    expect(resolveProjectApiHost("77az24zz7p", null)).toBe("77az24zz7p.api.82.157.196.165.sslip.io");
    expect(resolveProjectStudioHost("77az24zz7p", null)).toBe("studio-77az24zz7p.82.157.196.165.sslip.io");
  });

  test("parses JSON string routing config before legacy string-as-domain fallback", () => {
    const configJson = '{"postgrest_port":3234,"gotrue_port":4234,"custom_domain":"example.com"}';

    expect(normalizeProjectRoutingConfig(configJson)).toEqual({
      postgrest_port: 3234,
      gotrue_port: 4234,
      custom_domain: "example.com",
    });
    expect(resolveTenantPorts(configJson)).toEqual({ pgrstPort: 3234, gotruePort: 4234 });
    expect(resolveProjectApiHost("77az24zz7p", configJson)).toBe("api.example.com");
  });

  test("keeps non-JSON strings as legacy custom domains", () => {
    expect(normalizeProjectRoutingConfig("example.com")).toEqual({ custom_domain: "example.com" });
    expect(normalizeProjectRoutingConfig("{bad json")).toEqual({ custom_domain: "{bad json" });
  });

  test("uses ENABLE_SSL to resolve public API and Studio URL schemes", () => {
    config.baseDomain = "192.168.1.168.sslip.io";

    config.enableSsl = true;
    expect(resolveProjectApiUrl("dglewlzugrtygzysqrce", null)).toBe("https://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectStudioUrl("dglewlzugrtygzysqrce", null)).toBe("https://studio-dglewlzugrtygzysqrce.192.168.1.168.sslip.io");

    config.enableSsl = false;
    expect(resolveProjectApiUrl("dglewlzugrtygzysqrce", null)).toBe("http://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectStudioUrl("dglewlzugrtygzysqrce", null)).toBe("http://studio-dglewlzugrtygzysqrce.192.168.1.168.sslip.io");
  });
});
