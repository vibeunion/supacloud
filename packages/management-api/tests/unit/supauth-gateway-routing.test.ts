import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/services/gateway.service.ts", import.meta.url), "utf8");

describe("SupAuth gateway routing", () => {
  test("routes every shared auth request through the owner-aware SDK proxy", () => {
    expect(source).toContain("const sharedAuthProxy = sharedAuthPort !== null");
    expect(source).toContain("? `${hostIp}:${config.port}`");
    expect(source).toContain('id: caddyRouteId(projectRef, "auth")');
    expect(source).toContain("upstream: authUpstream");
    expect(source).toContain('stripPrefix: sharedAuthProxy ? undefined : "/auth/v1"');
  });

  test("keeps well-known metadata on the direct owner runtime", () => {
    expect(source).toContain("const directAuthUpstream = sharedAuthPort !== null");
    expect(source).toContain('id: caddyRouteId(projectRef, "gotrue-well-known")');
    expect(source).toContain('id: caddyRouteId(projectRef, "auth-domain-gotrue-well-known")');
    expect(source).toContain('rewriteUri: "/.well-known/oauth-authorization-server"');
    expect(source).toContain("upstream: directAuthUpstream");
  });

  test("shared auth always overrides a dependent external auth upstream", () => {
    expect(source).toContain("!externalAuthUpstream || sharedAuthProxy");
    expect(source).toContain("sharedAuthPort !== null");
    expect(source).toContain("X-Project-Ref:${config.authRuntimeOwnerRef}");
    expect(source).toContain("const authUpstreamTls = sharedAuthPort === null");
  });
});
