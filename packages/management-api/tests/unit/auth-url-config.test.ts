import { describe, expect, test } from "bun:test";
import {
  AuthUrlConfigValidationError,
  canonicalizeAuthUrlConfig,
} from "../../src/utils/auth-url-config";

describe("canonicalizeAuthUrlConfig", () => {
  test("stores valid intranet URLs under canonical auth keys", () => {
    expect(canonicalizeAuthUrlConfig({
      SITE_URL: "http://192.168.200.112:3010",
      URI_ALLOW_LIST: " http://192.168.200.112:3010/callback, https://*.example.com/** ",
    })).toEqual({
      site_url: "http://192.168.200.112:3010",
      uri_allow_list: "http://192.168.200.112:3010/callback,https://*.example.com/**",
    });
  });

  test("allows an empty uri_allow_list to clear redirect URLs", () => {
    expect(canonicalizeAuthUrlConfig({ uri_allow_list: "   " })).toEqual({
      uri_allow_list: "",
    });
  });

  test.each([
    "",
    "relative/path",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/callback?token=value",
    "https://example.com/#fragment",
    "https://example.com\\callback",
    "https://example.com/%0Ainjected",
  ])("rejects an unsafe site_url (%s)", (siteUrl) => {
    expect(() => canonicalizeAuthUrlConfig({ site_url: siteUrl }))
      .toThrow(AuthUrlConfigValidationError);
    try {
      canonicalizeAuthUrlConfig({ site_url: siteUrl });
    } catch (error) {
      expect(error).toMatchObject({ field: "SITE_URL" });
    }
  });

  test("rejects conflicting uppercase URL aliases", () => {
    expect(() => canonicalizeAuthUrlConfig({
      site_url: "https://app.example.com",
      SITE_URL: "https://other.example.com",
    })).toThrow(/conflicts with SITE_URL/);
  });

  test.each([
    ["array", ["https://app.example.com/callback"]],
    ["object", { url: "https://app.example.com/callback" }],
    ["relative URL", "/callback"],
    ["non-HTTP URL", "ftp://app.example.com/callback"],
    ["userinfo", "https://user:password@app.example.com/callback"],
    ["empty entry", "https://app.example.com/callback,,https://other.example.com/callback"],
    ["control character", "https://app.example.com/callback\n"],
    ["encoded control character", "https://app.example.com/%0Acallback"],
  ])("rejects an invalid uri_allow_list (%s)", (_caseName, uriAllowList) => {
    expect(() => canonicalizeAuthUrlConfig({ uri_allow_list: uriAllowList }))
      .toThrow(AuthUrlConfigValidationError);
    try {
      canonicalizeAuthUrlConfig({ uri_allow_list: uriAllowList });
    } catch (error) {
      expect(error).toMatchObject({ field: "URI_ALLOW_LIST" });
    }
  });
});
