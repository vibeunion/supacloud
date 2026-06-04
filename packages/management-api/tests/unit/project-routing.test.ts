import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  deriveStudioHostFromApiHost,
  normalizeProjectRoutingConfig,
  normalizeBaseDomain,
  resolveTenantPorts,
  resolveProjectApiHost,
  resolveProjectApiHosts,
  resolveProjectApiUrl,
  resolveProjectAuthHost,
  resolveProjectAuthUrl,
  resolveProjectBaseHost,
  resolveProjectStudioHost,
  resolveProjectStudioUrl,
  matchProjectRefFromHost,
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

  test("matches hosts from serialized routing config strings", () => {
    const configJson = '{"custom_domain":"api.aorist.net","studio_domain":"studio.aorist.net"}';

    expect(matchProjectRefFromHost("api.aorist.net", "77az24zz7p", configJson)).toBe(true);
    expect(matchProjectRefFromHost("studio.aorist.net", "77az24zz7p", configJson)).toBe(true);
    expect(matchProjectRefFromHost("api.other.example", "77az24zz7p", configJson)).toBe(false);
  });

  test("resolves dedicated auth domains without changing the API host", () => {
    const projectConfig = {
      api_domain: "api.example.com",
      auth_domain: "auth.example.com",
      studio_domain: "studio.example.com",
    };

    expect(resolveProjectApiHost("77az24zz7p", projectConfig)).toBe("api.example.com");
    expect(resolveProjectAuthHost("77az24zz7p", projectConfig)).toBe("auth.example.com");
    expect(matchProjectRefFromHost("auth.example.com", "77az24zz7p", projectConfig)).toBe(true);
  });

  test("supports additional API domains for routing host matching", () => {
    config.baseDomain = "ai.xigu.team";
    const projectConfig = {
      api_domain: "api.xgic-ingest.192.168.1.48.sslip.io",
      additional_api_domains: ["ingest-api.ai.xigu.team", "api.xgic-ingest.ai.xigu.team"],
    };

    expect(resolveProjectApiHost("afemibrarjkvzuuawjfi", projectConfig)).toBe("api.xgic-ingest.192.168.1.48.sslip.io");
    expect(resolveProjectApiHosts("afemibrarjkvzuuawjfi", projectConfig)).toEqual([
      "afemibrarjkvzuuawjfi.api.ai.xigu.team",
      "api.xgic-ingest.192.168.1.48.sslip.io",
      "ingest-api.ai.xigu.team",
      "api.xgic-ingest.ai.xigu.team",
    ]);
    expect(matchProjectRefFromHost("ingest-api.ai.xigu.team", "afemibrarjkvzuuawjfi", projectConfig)).toBe(true);
    expect(matchProjectRefFromHost("api.xgic-ingest.ai.xigu.team", "afemibrarjkvzuuawjfi", projectConfig)).toBe(true);
    expect(matchProjectRefFromHost("ingest-api.other.example", "afemibrarjkvzuuawjfi", projectConfig)).toBe(false);
  });

  test("derives Studio host from an api-prefixed API domain when Studio domain is not explicit", () => {
    const projectConfig = {
      api_domain: "api.ai.xigu.team",
    };

    expect(deriveStudioHostFromApiHost(projectConfig.api_domain)).toBe("studio.ai.xigu.team");
    expect(resolveProjectStudioHost("77az24zz7p", projectConfig)).toBe("studio.ai.xigu.team");
    expect(matchProjectRefFromHost("studio.ai.xigu.team", "77az24zz7p", projectConfig)).toBe(true);
  });

  test("does not derive Studio host from non-api API domains", () => {
    config.baseDomain = "82.157.196.165.sslip.io";
    const projectConfig = {
      api_domain: "xgapi.aizhuliren.cn",
    };

    expect(deriveStudioHostFromApiHost(projectConfig.api_domain)).toBeUndefined();
    expect(resolveProjectStudioHost("77az24zz7p", projectConfig)).toBe("studio-77az24zz7p.82.157.196.165.sslip.io");
  });

  test("keeps explicit Studio domain above the API-domain fallback", () => {
    const projectConfig = {
      api_domain: "api.ai.xigu.team",
      studio_domain: "studio.custom.example.com",
    };

    expect(resolveProjectStudioHost("77az24zz7p", projectConfig)).toBe("studio.custom.example.com");
  });

  test("uses ENABLE_SSL to resolve public API and Studio URL schemes", () => {
    config.baseDomain = "192.168.1.168.sslip.io";

    config.enableSsl = true;
    expect(resolveProjectApiUrl("dglewlzugrtygzysqrce", null)).toBe("https://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectAuthUrl("dglewlzugrtygzysqrce", null)).toBe("https://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectStudioUrl("dglewlzugrtygzysqrce", null)).toBe("https://studio-dglewlzugrtygzysqrce.192.168.1.168.sslip.io");

    config.enableSsl = false;
    expect(resolveProjectApiUrl("dglewlzugrtygzysqrce", null)).toBe("http://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectAuthUrl("dglewlzugrtygzysqrce", null)).toBe("http://dglewlzugrtygzysqrce.api.192.168.1.168.sslip.io");
    expect(resolveProjectStudioUrl("dglewlzugrtygzysqrce", null)).toBe("http://studio-dglewlzugrtygzysqrce.192.168.1.168.sslip.io");
  });
});
