import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

describe("Edge Runtime auth material invalidation", () => {
  test("runtime env invalidation clears tenant environment material", () => {
    const endpoint = source.slice(
      source.indexOf('.post("/invalidate-env/:ref"'),
      source.indexOf('.post("/preheat/:ref/:slug"'),
    );
    expect(endpoint).toContain("invalidateTenantEnvCache(c.params.ref)");
    expect(endpoint).not.toContain("secretsCache");
  });

  test("does not treat an unknown runtime mode as local during fallback", () => {
    expect(source).toContain("/auth/runtime");
    expect(source).toContain("if (authRuntime.mode === \"shared\")");
    expect(source).toContain("Refusing local fallback secrets for SupAuth dependent");
  });

  test("preheats an explicitly requested inactive function version", () => {
    const endpoint = source.slice(
      source.indexOf('.post("/preheat/:ref/:slug"'),
      source.indexOf('.post("/internal/background/:ref/:functionName/*"'),
    );
    expect(endpoint).toContain('headers.get("x-supacloud-function-version")');
    expect(endpoint).toContain("requestedVersion,");
    expect(endpoint).toContain("`_v${requestedVersion}`");
    expect(endpoint).toContain("version: requestedVersion");
  });
});
