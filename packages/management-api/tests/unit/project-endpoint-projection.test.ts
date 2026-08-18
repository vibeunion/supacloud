import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  buildProjectEndpointsProjection,
  PROJECT_ENDPOINTS_SCHEMA,
} from "../../src/utils/project-endpoint-projection";

const originalBaseDomain = config.baseDomain;
const originalEnableSsl = config.enableSsl;

afterEach(() => {
  config.baseDomain = originalBaseDomain;
  config.enableSsl = originalEnableSsl;
});

describe("project endpoint projection", () => {
  test("projects explicit domains and preserves canonical API aliases", () => {
    config.baseDomain = "platform.example";
    config.enableSsl = false;

    expect(buildProjectEndpointsProjection("abc123", {
      api_domain: "api.example.com",
      auth_domain: "auth.example.com",
      additional_api_domains: ["api-alt.example.com"],
    })).toEqual({
      schema: PROJECT_ENDPOINTS_SCHEMA,
      project_ref: "abc123",
      endpoints: {
        api: {
          origin: "https://api.example.com",
          host: "api.example.com",
          scheme: "https",
          source: "explicit_api_domain",
          aliases: ["abc123.api.platform.example", "api-alt.example.com"],
        },
        auth: {
          origin: "https://auth.example.com",
          host: "auth.example.com",
          scheme: "https",
          source: "explicit_auth_domain",
          aliases: [],
        },
        studio: {
          origin: "https://studio.example.com",
          host: "studio.example.com",
          scheme: "https",
          source: "derived_api_domain",
          aliases: [],
        },
      },
    });
  });

  test("labels custom-domain and generated endpoint sources without claiming readiness", () => {
    config.baseDomain = "192.168.1.10.sslip.io";
    config.enableSsl = false;

    const custom = buildProjectEndpointsProjection("abc123", "example.com");
    expect(custom.endpoints.api).toMatchObject({
      origin: "https://api.example.com",
      source: "custom_domain",
    });
    expect(custom.endpoints.auth).toMatchObject({
      origin: "https://api.example.com",
      source: "custom_domain",
    });
    expect(custom.endpoints.studio).toMatchObject({
      origin: "https://studio.example.com",
      source: "custom_domain",
    });

    const generated = buildProjectEndpointsProjection("abc123", null);
    expect(generated.endpoints.api).toMatchObject({
      origin: "http://abc123.api.192.168.1.10.sslip.io",
      source: "generated",
    });
    expect(generated.endpoints.auth).toMatchObject({
      origin: "http://abc123.api.192.168.1.10.sslip.io",
      source: "generated",
    });
    expect(generated.endpoints.studio).toMatchObject({
      origin: "http://studio-abc123.192.168.1.10.sslip.io",
      source: "generated",
    });
  });

  test("fails closed instead of silently dropping an invalid API alias", () => {
    config.baseDomain = "platform.example";
    config.enableSsl = true;

    expect(() => buildProjectEndpointsProjection("abc123", {
      api_domain: "api.example.com",
      additional_api_domains: ["operator@example.com"],
    })).toThrow("Project endpoint alias is invalid");
  });
});
