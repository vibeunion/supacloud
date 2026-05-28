import { describe, expect, test } from "bun:test";
import {
  mergeProjectConfig,
  normalizeOAuthServerConfig,
  normalizeProjectConfig,
} from "../../src/utils/project-config";

describe("project-config utils", () => {
  test("parses serialized JSON config objects", () => {
    expect(
      normalizeProjectConfig('{"postgrest_port":3234,"custom_domain":"example.com"}'),
    ).toEqual({
      postgrest_port: 3234,
      custom_domain: "example.com",
    });
  });

  test("ignores invalid or non-object config payloads", () => {
    expect(normalizeProjectConfig("not-json")).toEqual({});
    expect(normalizeProjectConfig('["array"]')).toEqual({});
    expect(normalizeProjectConfig(null)).toEqual({});
  });

  test("merges patch data onto normalized config", () => {
    expect(
      mergeProjectConfig('{"postgrest_port":3234}', {
        gotrue_port: 3334,
      }),
    ).toEqual({
      postgrest_port: 3234,
      gotrue_port: 3334,
    });
  });

  test("normalizes OAuth server camelCase authorization path to snake_case", () => {
    expect(
      normalizeOAuthServerConfig({
        enabled: true,
        authorizationPath: "/authorize.html",
      }),
    ).toEqual({
      enabled: true,
      authorization_path: "/authorize.html",
    });
  });
});
