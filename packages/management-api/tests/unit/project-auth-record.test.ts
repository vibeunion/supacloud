import { describe, expect, test } from "bun:test";
import {
  parseOAuthServerSettings, parseProjectAuthConfig, parseProjectAuthRows, ProjectAuthContextError,
} from "../../src/utils/project-auth-record";

const ref = "proj_1";
function row(overrides: Record<string, unknown> = {}) {
  return {
    ref, organization_id: "org_1", jwt_secret: "synthetic-jwt-secret",
    config: { auth: { oauth_server: { enabled: false } } }, ...overrides,
  };
}

describe("persisted project auth records", () => {
  test("preserves validated identity, configuration and nullable organization", () => {
    expect(parseProjectAuthRows([row()], ref)).toEqual(row());
    expect(parseProjectAuthRows([row({ organization_id: null })], ref))
      .toMatchObject({ organization_id: null });
    expect(parseProjectAuthRows([], ref)).toBeNull();
    expect(parseProjectAuthRows([row({ config: null })], ref)).toMatchObject({ config: {} });
  });

  test("decodes one legacy JSON text layer without coercing invalid records", () => {
    const config = { auth: { oauth_server: { enabled: true, authorizationPath: "/consent" } } };
    expect(parseProjectAuthRows([row({ config: JSON.stringify(config) })], ref)).toMatchObject({ config });
    expect(parseOAuthServerSettings(config.auth.oauth_server)).toEqual({
      enabled: true, authorization_path: "/consent",
    });
  });

  test.each([
    null, {}, [null], [row(), row()],
    [row({ ref: "other-project" })], [row({ ref: null })],
    [row({ organization_id: 1 })], [row({ organization_id: "" })],
    [row({ jwt_secret: null })], [row({ jwt_secret: 12 })],
    [row({ config: undefined })], [row({ config: [] })], [row({ config: 1 })],
    [row({ config: "" })], [row({ config: "{private-invalid-json" })],
    [row({ config: "null" })], [row({ config: JSON.stringify(JSON.stringify({ auth: {} })) })],
    [row({ config: JSON.stringify([]) })], [row({ config: { auth: [] } })],
    [row({ config: { auth: { oauth_server: { enabled: "false" } } } })],
  ].map((value) => ({ value })))("rejects invalid auth row envelope %# with a generic error", ({ value }) => {
    expect(() => parseProjectAuthRows(value, ref)).toThrow(ProjectAuthContextError);
    try {
      parseProjectAuthRows(value, ref);
      throw new Error("Expected invalid record rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProjectAuthContextError);
      expect(String(error)).not.toContain("synthetic-jwt-secret");
      expect(String(error)).not.toContain("private-invalid-json");
    }
  });

  test.each([
    [], "private-config", 1, { enabled: "true" }, { allow_dynamic_registration: 1 },
    { issuer: {} }, { issuer: "" }, { migrated_at: [] }, { signing_alg: false },
    { key_id: 42 }, { authorization_path: [] }, { authorizationPath: false },
  ].map((value) => ({ value })))("rejects invalid OAuth settings %# instead of asserting their type", ({ value }) => {
    expect(() => parseOAuthServerSettings(value)).toThrow(ProjectAuthContextError);
  });

  test("allows only absent auth settings to use the empty configuration default", () => {
    expect(parseProjectAuthConfig(undefined)).toEqual({});
    expect(parseProjectAuthConfig(null)).toEqual({});
    expect(() => parseProjectAuthConfig(false)).toThrow(ProjectAuthContextError);
    expect(() => parseProjectAuthConfig("")).toThrow(ProjectAuthContextError);
  });
});
