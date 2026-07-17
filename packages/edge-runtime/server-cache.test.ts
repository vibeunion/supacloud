import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

describe("Edge Runtime cache invalidation", () => {
  test("runtime env invalidation also clears cached JWT verification material", () => {
    const endpoint = source.slice(
      source.indexOf('.post("/invalidate-env/:ref"'),
      source.indexOf('.post("/preheat/:ref/:slug"'),
    );
    expect(endpoint).toContain("invalidateTenantEnvCache(c.params.ref)");
    expect(endpoint).toContain("secretsCache.delete(c.params.ref)");
  });

  test("does not treat an unknown runtime mode as local during fallback", () => {
    expect(source).toContain("/auth/runtime");
    expect(source).toContain("if (authRuntime.mode === \"shared\")");
    expect(source).toContain("Refusing local fallback secrets for SupAuth dependent");
  });
});
