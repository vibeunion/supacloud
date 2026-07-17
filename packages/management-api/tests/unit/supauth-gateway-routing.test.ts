import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/services/gateway.service.ts", import.meta.url), "utf8");

describe("SupAuth gateway routing", () => {
  test("routes every shared auth request through the owner-aware SDK proxy", () => {
    expect(source).toContain("const sharedAuthProxy = sharedAuthPort !== null && !externalAuthUpstream");
    expect(source).toContain("? `${hostIp}:${config.port}`");
    expect(source).toContain('id: caddyRouteId(projectRef, "auth")');
    expect(source).toContain("upstream: authUpstream");
    expect(source).toContain('stripPrefix: sharedAuthProxy ? undefined : "/auth/v1"');
  });

  test("keeps well-known metadata on the direct owner runtime", () => {
    expect(source).toContain("const directAuthUpstream = externalAuthUpstream?.dial");
    expect(source).toContain('id: caddyRouteId(projectRef, "gotrue-well-known")');
    expect(source).toContain("upstream: directAuthUpstream");
  });
});
