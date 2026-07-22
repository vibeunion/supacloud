import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OAUTH_AUTHORIZATION_PATH,
  OAuthAuthorizationPathError,
  resolveOAuthAuthorizationPath,
  validateOAuthAuthorizationPath,
} from "../../src/utils/oauth-authorization-path";

describe("OAuth authorization path", () => {
  test("defaults migration to the public hosted authorize page path", () => {
    expect(resolveOAuthAuthorizationPath(undefined, undefined)).toBe(DEFAULT_OAUTH_AUTHORIZATION_PATH);
  });

  test("keeps a valid existing origin-relative path", () => {
    expect(resolveOAuthAuthorizationPath(undefined, "/custom/authorize.html")).toBe("/custom/authorize.html");
  });

  test.each([
    "https://auth.example.com/authorize.html",
    "//auth.example.com/authorize.html",
    "/authorize.html?client_id=attacker",
    "/authorize.html#fragment",
    "/a\\b",
    "/../authorize.html",
    "/%2e%2e/authorize.html",
    "/authorize.html\u0000",
  ])("rejects unsafe authorization path %s", (path) => {
    expect(() => validateOAuthAuthorizationPath(path)).toThrow(OAuthAuthorizationPathError);
  });

  test("rejects an invalid explicit path instead of silently falling back", () => {
    expect(() => resolveOAuthAuthorizationPath("https://auth.example.com/authorize.html", undefined))
      .toThrow(OAuthAuthorizationPathError);
  });

  test("repairs a legacy invalid stored value when no explicit override is provided", () => {
    expect(resolveOAuthAuthorizationPath(undefined, "https://auth.example.com/authorize.html"))
      .toBe(DEFAULT_OAUTH_AUTHORIZATION_PATH);
  });
});
